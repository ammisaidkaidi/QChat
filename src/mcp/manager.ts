/**
 * MCP server pool.
 *
 * Servers are declared in `mcp.json` at the project root (override with
 * `INFAGENT_MCP_CONFIG`):
 *
 *   {
 *     "servers": {
 *       "example": { "command": "node", "args": ["mcp/example-server.mjs"], "enabled": true }
 *     }
 *   }
 *
 * The manager starts the enabled ones lazily, aggregates their tools under a
 * `server__tool` name (so two servers may both expose `search`), and keeps the
 * last error of each server so the interface can explain what went wrong.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { McpClient, McpError } from './client.js';
import type { McpServerConfig, McpTool } from './client.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const DEFAULT_MCP_CONFIG = join(ROOT, 'mcp.json');

export interface McpServerStatus {
  name: string;
  state: McpClient['state'];
  description: string;
  command: string;
  args: string[];
  enabled: boolean;
  tools: McpTool[];
  serverInfo: { name?: string; version?: string };
  lastError: string | null;
  stderr: string[];
}

export interface McpCatalogue {
  configPath: string;
  servers: McpServerStatus[];
  /** Every tool, namespaced as the model sees it. */
  tools: { server: string; name: string; qualified: string; description: string }[];
}

/** Split `server__tool` (or a bare tool name when unambiguous) into its parts. */
export function parseQualifiedTool(
  raw: string,
  servers: readonly string[],
): { server: string; tool: string } | null {
  const separator = raw.indexOf('__');
  if (separator > 0) {
    const server = raw.slice(0, separator);
    const tool = raw.slice(separator + 2);
    if (tool && (servers.length === 0 || servers.includes(server))) return { server, tool };
  }
  return null;
}

const DEFAULT_CONFIG = {
  servers: {
    example: {
      command: 'node',
      args: ['mcp/example-server.mjs'],
      description: 'Bundled demo server (echo, add, now) — replace or remove it.',
      enabled: true,
    },
  },
};

export class McpManager {
  public readonly configPath: string;
  private clients = new Map<string, McpClient>();
  private config: Record<string, McpServerConfig> = {};

  constructor(options: { configPath?: string } = {}) {
    this.configPath = resolve(
      options.configPath ?? process.env['INFAGENT_MCP_CONFIG'] ?? DEFAULT_MCP_CONFIG,
    );
    this.load();
  }

  /** Read the config file, creating a usable default one when it is missing. */
  public load(): Record<string, McpServerConfig> {
    if (!existsSync(this.configPath)) {
      try {
        writeFileSync(this.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
      } catch {
        /* read-only checkout: run with the in-memory defaults */
      }
    }

    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as {
        servers?: Record<string, McpServerConfig>;
      };
      this.config = parsed.servers ?? {};
    } catch {
      this.config = DEFAULT_CONFIG.servers as Record<string, McpServerConfig>;
    }

    // Drop clients whose server disappeared from the config.
    for (const [name, client] of this.clients) {
      if (!this.config[name]) {
        void client.stop();
        this.clients.delete(name);
      }
    }

    return this.config;
  }

  public save(): void {
    const payload = { servers: this.config };
    writeFileSync(this.configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  public names(): string[] {
    return Object.keys(this.config);
  }

  /** Register (or replace) a server definition. */
  public addServer(name: string, config: McpServerConfig): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new McpError('spawn', `Invalid server name "${name}".`);
    }
    this.config[name] = config;
    const existing = this.clients.get(name);
    if (existing) {
      void existing.stop();
      this.clients.delete(name);
    }
    this.save();
  }

  public async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      await client.stop();
      this.clients.delete(name);
    }
    delete this.config[name];
    this.save();
  }

  private clientFor(name: string): McpClient {
    const config = this.config[name];
    if (!config) throw new McpError('spawn', `Unknown MCP server "${name}".`);

    let client = this.clients.get(name);
    if (!client) {
      // Script paths in the config are resolved against the config file's folder
      // (then the working directory); absolute paths are left alone.
      const args = (config.args ?? []).map((arg) => {
        if (!/\.m?js$/i.test(arg) || isAbsolute(arg)) return arg;
        const besideConfig = join(dirname(this.configPath), arg);
        if (existsSync(besideConfig)) return besideConfig;
        const fromCwd = resolve(process.cwd(), arg);
        return existsSync(fromCwd) ? fromCwd : arg;
      });
      client = new McpClient(name, { ...config, args });
      this.clients.set(name, client);
    }
    return client;
  }

  public async start(name: string): Promise<McpServerStatus> {
    const client = this.clientFor(name);
    if (client.state !== 'ready') {
      try {
        await client.start();
      } catch (error) {
        client.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return this.status(name);
  }

  /** Start everything that is enabled; failures are recorded, never fatal. */
  public async startEnabled(): Promise<McpServerStatus[]> {
    const names = Object.entries(this.config)
      .filter(([, config]) => config.enabled !== false)
      .map(([name]) => name);

    for (const name of names) await this.start(name);
    return this.list();
  }

  public async stop(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) await client.stop();
  }

  public async stopAll(): Promise<void> {
    for (const client of this.clients.values()) await client.stop();
  }

  public status(name: string): McpServerStatus {
    const config = this.config[name] ?? { command: '' };
    const client = this.clients.get(name);

    return {
      name,
      state: client?.state ?? 'stopped',
      description: config.description ?? '',
      command: config.command,
      args: config.args ?? [],
      enabled: config.enabled !== false,
      tools: client?.tools ?? [],
      serverInfo: client?.serverInfo ?? {},
      lastError: client?.lastError ?? null,
      stderr: client?.stderr.slice(-10) ?? [],
    };
  }

  public list(): McpServerStatus[] {
    return this.names().map((name) => this.status(name));
  }

  /** The catalogue shown in the interface and offered to the model. */
  public catalogue(): McpCatalogue {
    const servers = this.list();
    return {
      configPath: this.configPath,
      servers,
      tools: servers.flatMap((server) =>
        server.tools.map((tool) => ({
          server: server.name,
          name: tool.name,
          qualified: `${server.name}__${tool.name}`,
          description: tool.description,
        })),
      ),
    };
  }

  /** Ready servers only — used when building the prompt. */
  public tools(): { server: string; tool: McpTool }[] {
    return [...this.clients.entries()]
      .filter(([, client]) => client.state === 'ready')
      .flatMap(([server, client]) => client.tools.map((tool) => ({ server, tool })));
  }

  /** Execute a namespaced call, starting the server first when needed. */
  public async call(
    qualified: string,
    args: Record<string, unknown>,
  ): Promise<{ server: string; tool: string; result: Awaited<ReturnType<McpClient['callTool']>> }> {
    const parsed = parseQualifiedTool(qualified, this.names());
    if (!parsed) {
      throw new McpError('tool', `"${qualified}" is not an MCP tool name (expected server__tool).`);
    }

    const client = this.clientFor(parsed.server);
    if (client.state !== 'ready') await this.start(parsed.server);
    if (client.state !== 'ready') {
      throw new McpError(
        'closed',
        client.lastError ?? `MCP server "${parsed.server}" is not ready.`,
      );
    }

    const result = await client.callTool(parsed.tool, args);
    return { server: parsed.server, tool: parsed.tool, result };
  }
}

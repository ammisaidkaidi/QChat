/**
 * Minimal MCP (Model Context Protocol) client over stdio.
 *
 * Speaks newline-delimited JSON-RPC 2.0 to a server process:
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize", …}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":…,"serverInfo":…}}
 *   → {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   → {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":…,"arguments":{…}}}
 *
 * Deliberately dependency-free: spawning a process and writing lines covers
 * every stdio server, which is what `npx @modelcontextprotocol/server-*` ships.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpTool {
  name: string;
  description: string;
  /** JSON schema as published by the server. */
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  /** `stdio` (default) spawns `command`; `http` talks to a remote endpoint. */
  transport?: 'stdio' | 'http';
  /** Endpoint for `transport: "http"`, e.g. https://mcp.supabase.com/mcp?… */
  url?: string;
  /** Headers for `transport: "http"`; read tokens through ${ENV} placeholders. */
  headers?: Record<string, string>;
  /** Executable to run, e.g. `node` or `npx`. */
  command: string;
  args?: string[];
  /** Extra environment for the server process. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
  enabled?: boolean;
  /** Human note shown in the interface. */
  description?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface McpToolResult {
  ok: boolean;
  /** Flattened text of every content block. */
  text: string;
  /** Raw content blocks, for the UI. */
  content: unknown;
  isError: boolean;
  durationMs: number;
}

export class McpError extends Error {
  public readonly code: 'spawn' | 'protocol' | 'timeout' | 'closed' | 'tool';

  constructor(code: McpError['code'], message: string) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** One connected MCP server. */
export class McpClient {
  public readonly name: string;
  public readonly config: McpServerConfig;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readonly timeoutMs: number;

  public serverInfo: { name?: string; version?: string } = {};
  public tools: McpTool[] = [];
  /** When the server last announced a change to its tool list. */
  public toolsChangedAt: string | null = null;
  public state: 'stopped' | 'starting' | 'ready' | 'error' = 'stopped';
  public lastError: string | null = null;
  public stderr: string[] = [];

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  /** Start the process and complete the handshake. */
  public async start(): Promise<void> {
    if (this.child) return;

    this.state = 'starting';
    this.lastError = null;

    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd ?? process.cwd(),
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.stderr.push(line.trim());
      }
      if (this.stderr.length > 50) this.stderr.splice(0, this.stderr.length - 50);
    });

    child.on('error', (error) => {
      this.state = 'error';
      this.lastError = error.message;
      this.failAll(new McpError('spawn', `Could not start "${this.name}": ${error.message}`));
    });

    child.on('close', (code) => {
      this.child = null;
      this.state = 'stopped';
      this.failAll(
        new McpError('closed', `MCP server "${this.name}" exited (code ${code ?? '?'}).`),
      );
    });

    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'InfAgent', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };

    this.serverInfo = result?.serverInfo ?? {};
    this.notify('notifications/initialized');
    this.tools = await this.listTools();
    this.state = 'ready';
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      return;
    }

    this.child = null;
    this.state = 'stopped';
    this.failAll(new McpError('closed', `MCP server "${this.name}" was stopped.`));
    child.kill('SIGTERM');
    await new Promise<void>((resolveStop) => setTimeout(resolveStop, 120));
    if (!child.killed) child.kill('SIGKILL');
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Re-read the tool list after the server says it changed.
   *
   * The toolbox loads tools from files, so its list moves while it runs. The
   * chat rebuilds its system prompt from `tools()` every turn, which means a
   * refreshed list is in the model's context from the next message on.
   */
  public async refreshTools(): Promise<McpTool[]> {
    if (!this.child) return this.tools;
    try {
      this.tools = await this.listTools();
      this.toolsChangedAt = new Date().toISOString();
    } catch (error) {
      this.stderr.push(`[tools/list] ${(error as Error).message}`);
    }
    return this.tools;
  }

  public async listTools(): Promise<McpTool[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: { name?: string; description?: string; inputSchema?: unknown }[];
    };

    return (result?.tools ?? [])
      .filter((tool) => typeof tool.name === 'string')
      .map((tool) => ({
        name: tool.name as string,
        description: tool.description ?? '',
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === 'object'
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
      }));
  }

  /** Call a tool by its server-local name. */
  public async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const startedAt = Date.now();
    const result = (await this.request('tools/call', {
      name: toolName,
      arguments: args,
    })) as { content?: unknown; isError?: boolean };

    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .map((block) => {
        if (block && typeof block === 'object') {
          const record = block as Record<string, unknown>;
          if (typeof record['text'] === 'string') return record['text'];
          if (record['type'] === 'image') return '[image]';
          return JSON.stringify(record);
        }
        return String(block);
      })
      .join('\n')
      .trim();

    const isError = result?.isError === true;
    return {
      ok: !isError,
      text: text || '(no content)',
      content: result?.content ?? null,
      isError,
      durationMs: Date.now() - startedAt,
    };
  }

  private notify(method: string, params: unknown = {}): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child)
      return Promise.reject(new McpError('closed', `MCP server "${this.name}" is not running.`));

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new McpError('timeout', `"${this.name}" did not answer ${method} in time.`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Feed stdout chunks into the line parser. */
  private consume(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }

    if (this.buffer.length > 4_000_000) this.buffer = '';
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Servers may print banners; they are not protocol traffic.
      this.stderr.push(`[not json] ${line.slice(0, 200)}`);
      return;
    }

    const id = typeof message['id'] === 'number' ? message['id'] : null;
    if (id === null) {
      // A notification: no reply, but some of them matter. A server that
      // changes its tool list mid-session says so here.
      if (message['method'] === 'notifications/tools/list_changed') void this.refreshTools();
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message['error']) {
      const error = message['error'] as { message?: string };
      pending.reject(new McpError('tool', error.message ?? `"${pending.method}" failed.`));
      return;
    }

    pending.resolve(message['result']);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

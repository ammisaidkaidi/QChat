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
import { describeRemote, HttpMcpClient } from './http.js';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const DEFAULT_MCP_CONFIG = join(ROOT, 'mcp.json');
/** Split `server__tool` (or a bare tool name when unambiguous) into its parts. */
export function parseQualifiedTool(raw, servers) {
    const separator = raw.indexOf('__');
    if (separator > 0) {
        const server = raw.slice(0, separator);
        const tool = raw.slice(separator + 2);
        if (tool && (servers.length === 0 || servers.includes(server)))
            return { server, tool };
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
    configPath;
    clients = new Map();
    /** Config-level refusals, kept per server so the console can show them. */
    failures = new Map();
    config = {};
    constructor(options = {}) {
        this.configPath = resolve(options.configPath ?? process.env['INFAGENT_MCP_CONFIG'] ?? DEFAULT_MCP_CONFIG);
        this.load();
    }
    /** Read the config file, creating a usable default one when it is missing. */
    load() {
        if (!existsSync(this.configPath)) {
            try {
                writeFileSync(this.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
            }
            catch {
                /* read-only checkout: run with the in-memory defaults */
            }
        }
        try {
            const parsed = JSON.parse(readFileSync(this.configPath, 'utf8'));
            this.config = parsed.servers ?? {};
        }
        catch {
            this.config = DEFAULT_CONFIG.servers;
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
    save() {
        const payload = { servers: this.config };
        writeFileSync(this.configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    names() {
        return Object.keys(this.config);
    }
    /** Register (or replace) a server definition. */
    addServer(name, config) {
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
    async removeServer(name) {
        const client = this.clients.get(name);
        if (client) {
            await client.stop();
            this.clients.delete(name);
        }
        delete this.config[name];
        this.save();
    }
    clientFor(name) {
        const config = this.config[name];
        if (!config)
            throw new McpError('spawn', `Unknown MCP server "${name}".`);
        let client = this.clients.get(name);
        if (!client) {
            const expanded = expandConfig(config);
            if (expanded.transport === 'http') {
                assertRemoteAllowed(name, expanded);
                client = new HttpMcpClient(name, { ...expanded, url: expanded.url ?? '' });
            }
            else {
                // Script paths in the config are resolved against the config file's folder
                // (then the working directory); absolute paths are left alone.
                const args = (expanded.args ?? []).map((arg) => {
                    if (!/\.(m?js|cjs|py)$/i.test(arg) || isAbsolute(arg))
                        return arg;
                    const besideConfig = join(dirname(this.configPath), arg);
                    if (existsSync(besideConfig))
                        return besideConfig;
                    const fromCwd = resolve(process.cwd(), arg);
                    return existsSync(fromCwd) ? fromCwd : arg;
                });
                client = new McpClient(name, {
                    ...expanded,
                    args,
                    // Relative data paths inside a server config mean "next to mcp.json".
                    cwd: expanded.cwd ?? dirname(this.configPath),
                });
            }
            this.clients.set(name, client);
        }
        return client;
    }
    async start(name) {
        try {
            const client = this.clientFor(name);
            if (client.state !== 'ready')
                await client.start();
            this.failures.delete(name);
        }
        catch (error) {
            // A config that is refused (bad url, missing token, disabled write guard)
            // and a server that refuses to handshake land in the same place: the
            // server is reported as errored with the reason, and nothing else breaks.
            this.failures.set(name, error instanceof Error ? error.message : String(error));
        }
        return this.status(name);
    }
    /** Start everything that is enabled; failures are recorded, never fatal. */
    async startEnabled() {
        const names = Object.entries(this.config)
            .filter(([, config]) => config.enabled !== false)
            .map(([name]) => name);
        for (const name of names)
            await this.start(name);
        return this.list();
    }
    async stop(name) {
        const client = this.clients.get(name);
        if (client)
            await client.stop();
        this.failures.delete(name);
    }
    async stopAll() {
        for (const client of this.clients.values())
            await client.stop();
    }
    status(name) {
        const config = this.config[name] ?? { command: '' };
        const client = this.clients.get(name);
        return {
            name,
            // A refused config has no client, but the console must still see an error.
            state: this.failures.has(name) ? 'error' : (client?.state ?? 'stopped'),
            description: config.description ?? '',
            command: config.command,
            args: config.args ?? [],
            transport: config.transport === 'http' ? 'http' : 'stdio',
            // The same expansion the client used, so the console shows where it
            // really points (and never a token: describeRemote masks the query).
            url: config.transport === 'http' && config.url
                ? describeRemote({ ...config, url: expand(config.url) })
                : null,
            enabled: config.enabled !== false,
            tools: client?.tools ?? [],
            serverInfo: client?.serverInfo ?? {},
            lastError: client?.lastError ?? this.failures.get(name) ?? null,
            stderr: client?.stderr.slice(-10) ?? [],
            toolsChangedAt: client?.toolsChangedAt ?? null,
        };
    }
    list() {
        return this.names().map((name) => this.status(name));
    }
    /** The catalogue shown in the interface and offered to the model. */
    catalogue() {
        const servers = this.list();
        return {
            configPath: this.configPath,
            servers,
            tools: servers.flatMap((server) => server.tools.map((tool) => ({
                server: server.name,
                name: tool.name,
                qualified: `${server.name}__${tool.name}`,
                description: tool.description,
            }))),
        };
    }
    /** Ready servers only — used when building the prompt. */
    tools() {
        return [...this.clients.entries()]
            .filter(([, client]) => client.state === 'ready')
            .flatMap(([server, client]) => client.tools.map((tool) => ({ server, tool })));
    }
    /** Execute a namespaced call, starting the server first when needed. */
    async call(qualified, args) {
        const parsed = parseQualifiedTool(qualified, this.names());
        if (!parsed) {
            throw new McpError('tool', `"${qualified}" is not an MCP tool name (expected server__tool).`);
        }
        const client = this.clientFor(parsed.server);
        if (client.state !== 'ready')
            await this.start(parsed.server);
        if (client.state !== 'ready') {
            throw new McpError('closed', client.lastError ?? `MCP server "${parsed.server}" is not ready.`);
        }
        const result = await client.callTool(parsed.tool, args);
        return { server: parsed.server, tool: parsed.tool, result };
    }
}
/* ── config helpers ──────────────────────────────────────────────────────── */
/** Replace ${NAME} with the matching environment variable (empty when unset). */
function expand(value) {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? '');
}
/** Same, over the strings of a whole server entry. */
function expandConfig(config) {
    const headers = config.headers
        ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expand(value)]))
        : undefined;
    const env = config.env
        ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)]))
        : undefined;
    return {
        ...config,
        ...(config.url ? { url: expand(config.url) } : {}),
        ...(headers ? { headers } : {}),
        ...(env ? { env } : {}),
        args: (config.args ?? []).map(expand),
    };
}
const SUPABASE_HOST = 'mcp.supabase.com';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/**
 * Remote servers get three hard rules, checked before a connection is attempted:
 * HTTPS (loopback http only with `INFAGENT_MCP_ALLOW_INSECURE=1`), a token that
 * really is present, and — for the official Supabase endpoint — read-only unless
 * `INFAGENT_ALLOW_SUPABASE_WRITES=1`, so a missing flag cannot turn into an
 * accidental write against a real project.
 */
function assertRemoteAllowed(name, config) {
    const url = config.url ?? '';
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new McpError('spawn', `"${name}": the remote url is not a valid URL.`);
    }
    if (parsed.protocol !== 'https:') {
        const loopback = LOOPBACK.has(parsed.hostname.toLowerCase());
        if (!loopback || process.env['INFAGENT_MCP_ALLOW_INSECURE'] !== '1') {
            throw new McpError('spawn', `"${name}": remote MCP must use https (got ${parsed.protocol}). ` +
                'Loopback http is allowed only with INFAGENT_MCP_ALLOW_INSECURE=1.');
        }
    }
    if (parsed.host.toLowerCase() !== SUPABASE_HOST)
        return;
    const token = (config.headers?.['Authorization'] ?? config.headers?.['authorization'] ?? '')
        .replace(/^Bearer\s+/i, '')
        .trim();
    if (!token) {
        throw new McpError('spawn', `"${name}": no Supabase access token. Put SUPABASE_ACCESS_TOKEN in .env and reference it as ` +
            '"Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}" in mcp.json — never paste a token there.');
    }
    if (parsed.searchParams.get('read_only') !== 'true' &&
        process.env['INFAGENT_ALLOW_SUPABASE_WRITES'] !== '1') {
        throw new McpError('spawn', `"${name}": refused to connect without read_only=true. Set INFAGENT_ALLOW_SUPABASE_WRITES=1 ` +
            'to enable writes or migrations explicitly, and check the project ref first.');
    }
}
//# sourceMappingURL=manager.js.map
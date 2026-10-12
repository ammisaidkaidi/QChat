/**
 * MCP over Streamable HTTP.
 *
 * The same JSON-RPC 2.0 messages as the stdio client, carried in POST requests
 * the way the protocol specifies for remote servers (Supabase's official
 * endpoint is one):
 *
 *   POST <url>  Accept: application/json, text/event-stream
 *   → either a JSON body, or an SSE stream whose `data:` frames hold the reply
 *   ← `mcp-session-id` response header, echoed on later requests
 *
 * Secrets never leave the process: header values are read from the environment
 * at construction time, and every error message and stderr line is passed
 * through `redact()` first, so a token cannot reach a log, the interface or the
 * model.
 *
 * The request identifies itself with a real `User-Agent`: hosted endpoints sit
 * behind an edge (Supabase's is Cloudflare) that answers a bare or library
 * default agent with "403 Error 1010: browser_signature_banned", which looks
 * exactly like an auth failure and is not one.
 */
import { type McpServerConfig, type McpTool, type McpToolResult } from './client.js';
export interface HttpMcpConfig extends McpServerConfig {
    /** Endpoint of the remote server. */
    url: string;
    /** Extra headers, typically `{"Authorization": "Bearer …"}`. */
    headers?: Record<string, string>;
}
/** One header every remote request carries, so an edge cannot mistake us for a scraper. */
export declare const HTTP_MCP_USER_AGENT = "InfAgent/1.0 (+https://github.com/ammisaidkaidi/InfAgent; MCP client)";
/** Replace any credential-looking value with `***`, wherever it appears. */
export declare function redact(text: string, secrets?: readonly string[]): string;
/** Values in a config that must never be echoed, e.g. authorization headers. */
export declare function secretsOf(config: {
    headers?: Record<string, string>;
    env?: Record<string, string>;
}): string[];
export declare class HttpMcpClient {
    readonly name: string;
    readonly url: string;
    state: 'stopped' | 'starting' | 'ready' | 'error';
    tools: McpTool[];
    /**
     * When the server last announced a change to its tool list. Always null for
     * this transport: the hosted endpoints do not push notifications, so their
     * list is re-read on every start.
     */
    readonly toolsChangedAt: string | null;
    serverInfo: {
        name?: string;
        version?: string;
    };
    lastError: string | null;
    readonly stderr: string[];
    private readonly headers;
    private readonly timeoutMs;
    private readonly secrets;
    private sessionId;
    private nextId;
    constructor(name: string, config: HttpMcpConfig);
    /** Where this server lives, with any token in the query string removed. */
    get displayUrl(): string;
    private note;
    /** One POST; returns the JSON-RPC reply, unwrapping an SSE frame if needed. */
    private post;
    private request;
    start(): Promise<void>;
    stop(): Promise<void>;
    callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}
/** Query string of a URL, with anything secret-looking masked. */
export declare function describeRemote(config: HttpMcpConfig): string;
//# sourceMappingURL=http.d.ts.map
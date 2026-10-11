export declare const MCP_PROTOCOL_VERSION = "2024-11-05";
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
export declare class McpError extends Error {
    readonly code: 'spawn' | 'protocol' | 'timeout' | 'closed' | 'tool';
    constructor(code: McpError['code'], message: string);
}
/** One connected MCP server. */
export declare class McpClient {
    readonly name: string;
    readonly config: McpServerConfig;
    private child;
    private buffer;
    private nextId;
    private pending;
    private readonly timeoutMs;
    serverInfo: {
        name?: string;
        version?: string;
    };
    tools: McpTool[];
    state: 'stopped' | 'starting' | 'ready' | 'error';
    lastError: string | null;
    stderr: string[];
    constructor(name: string, config: McpServerConfig);
    /** Start the process and complete the handshake. */
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    listTools(): Promise<McpTool[]>;
    /** Call a tool by its server-local name. */
    callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult>;
    private notify;
    private request;
    /** Feed stdout chunks into the line parser. */
    private consume;
    private handleLine;
    private failAll;
}
//# sourceMappingURL=client.d.ts.map
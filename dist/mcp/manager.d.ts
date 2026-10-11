import { McpClient } from './client.js';
import type { McpServerConfig, McpTool } from './client.js';
export declare const DEFAULT_MCP_CONFIG: string;
export interface McpServerStatus {
    name: string;
    state: McpClient['state'];
    description: string;
    command: string;
    args: string[];
    enabled: boolean;
    tools: McpTool[];
    serverInfo: {
        name?: string;
        version?: string;
    };
    lastError: string | null;
    stderr: string[];
}
export interface McpCatalogue {
    configPath: string;
    servers: McpServerStatus[];
    /** Every tool, namespaced as the model sees it. */
    tools: {
        server: string;
        name: string;
        qualified: string;
        description: string;
    }[];
}
/** Split `server__tool` (or a bare tool name when unambiguous) into its parts. */
export declare function parseQualifiedTool(raw: string, servers: readonly string[]): {
    server: string;
    tool: string;
} | null;
export declare class McpManager {
    readonly configPath: string;
    private clients;
    private config;
    constructor(options?: {
        configPath?: string;
    });
    /** Read the config file, creating a usable default one when it is missing. */
    load(): Record<string, McpServerConfig>;
    save(): void;
    names(): string[];
    /** Register (or replace) a server definition. */
    addServer(name: string, config: McpServerConfig): void;
    removeServer(name: string): Promise<void>;
    private clientFor;
    start(name: string): Promise<McpServerStatus>;
    /** Start everything that is enabled; failures are recorded, never fatal. */
    startEnabled(): Promise<McpServerStatus[]>;
    stop(name: string): Promise<void>;
    stopAll(): Promise<void>;
    status(name: string): McpServerStatus;
    list(): McpServerStatus[];
    /** The catalogue shown in the interface and offered to the model. */
    catalogue(): McpCatalogue;
    /** Ready servers only — used when building the prompt. */
    tools(): {
        server: string;
        tool: McpTool;
    }[];
    /** Execute a namespaced call, starting the server first when needed. */
    call(qualified: string, args: Record<string, unknown>): Promise<{
        server: string;
        tool: string;
        result: Awaited<ReturnType<McpClient['callTool']>>;
    }>;
}
//# sourceMappingURL=manager.d.ts.map
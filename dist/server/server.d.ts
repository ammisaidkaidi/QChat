import type { Server } from 'node:http';
import { ScriptRegistry } from '../scripts/registry.js';
import type { ScriptLanguage } from '../scripts/types.js';
import { QwenEngine } from '../chat/qwen.js';
export interface ServerOptions {
    /** Registry backing `/api/scripts`. Defaults to `<cwd>/scripts`. */
    registry?: ScriptRegistry;
    /** Local model engine backing `/api/chat`. Defaults to a CPU Qwen3 engine. */
    engine?: QwenEngine;
    /** Folder with the built Vue app. Defaults to `<repo>/ui/dist`. */
    uiDir?: string;
    port?: number;
    host?: string;
}
export declare function createServer(options?: ServerOptions): Server;
export interface RunningServer {
    server: Server;
    port: number;
    url: string;
    close: () => Promise<void>;
}
export declare function startServer(options?: ServerOptions): Promise<RunningServer>;
export type { ScriptLanguage };
//# sourceMappingURL=server.d.ts.map
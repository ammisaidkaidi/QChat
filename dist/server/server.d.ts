import type { Server } from 'node:http';
import { ScriptRegistry } from '../scripts/registry.js';
import type { ScriptLanguage } from '../scripts/types.js';
import { QwenEngine } from '../chat/qwen.js';
import { McpManager } from '../mcp/manager.js';
import { SkillRegistry } from '../skills/registry.js';
import type { SystemPromptStore } from '../chat/prompts.js';
import { CloudInference, CloudProviderStore } from '../cloud/providers.js';
import type { AlertBus } from '../capabilities/alerts.js';
import { ChatStore } from './chatStore.js';
export interface ServerOptions {
    /** Registry backing `/api/scripts`. Defaults to `<cwd>/scripts`. */
    registry?: ScriptRegistry;
    /** Skill library backing `/api/skills`. */
    skills?: SkillRegistry;
    /** MCP server pool backing `/api/mcp`. */
    mcp?: McpManager;
    /** Alert bus backing `/api/alerts` — shared with the chat engine. */
    alerts?: AlertBus;
    /** Local model engine backing `/api/chat`. Defaults to a CPU Qwen3 engine. */
    engine?: QwenEngine;
    /** Folder with the built Vue app. Defaults to `<repo>/ui/dist`. */
    uiDir?: string;
    /** SQLite conversation store. Inject one in tests; the default lives in app data. */
    chatStore?: ChatStore;
    /** Cloud provider metadata store. Keys are resolved only through `.env`. */
    cloudProviders?: CloudProviderStore;
    /** Override the cloud inference adapter in tests. */
    cloudInference?: CloudInference;
    /** Override the SQLite path (`INFAGENT_DB_PATH`/app-data by default). */
    chatDbPath?: string;
    /** The `.env` the Config tab edits. Defaults to `<cwd>/.env`. */
    envFile?: string;
    /** Reference file whose comments explain each key. Defaults to `<cwd>/.env.example`. */
    envReference?: string;
    /** System-prompt templates. Defaults to the engine's store. */
    prompts?: SystemPromptStore;
    port?: number;
    host?: string;
}
/**
 * Where the built interface lives, derived from this module's own URL.
 *
 * `new URL(...).pathname` looks right and is wrong outside POSIX: on Windows it
 * returns `/D:/dev/app/ui/dist` — a leading slash with the drive letter inside —
 * and `path.resolve` then makes `D:\D:\dev\app\ui\dist`, a path that never
 * exists. The server answered "the Vue interface has not been built yet"
 * however often you built it. `fileURLToPath` is the conversion Node provides
 * for exactly this, and it decodes `%20` and friends on the way.
 */
export declare function resolveUiDir(moduleUrl: string): string;
/**
 * Which file answers a request path: the real file when it lives inside the
 * built interface, otherwise `index.html` so the app can route client-side.
 * `..` — plain or percent-encoded — never escapes `uiDir`, on either platform.
 */
export declare function staticFileFor(uiDir: string, pathname: string): string;
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
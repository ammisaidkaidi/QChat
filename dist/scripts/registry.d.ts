import type { CreateScriptInput, ScriptDetail, ScriptLanguage, ScriptMeta, ScriptRecord, ScriptRunResult, ScriptStats, ToolDefinition, UpdateScriptInput } from './types.js';
export declare const SCRIPT_NAME_PATTERN: RegExp;
export declare class ScriptError extends Error {
    readonly code: 'invalid_name' | 'not_found' | 'exists' | 'io' | 'disabled';
    constructor(code: ScriptError['code'], message: string);
}
export interface ScriptRegistryOptions {
    /** Folder holding agent scripts. Defaults to `$INFAGENT_SCRIPTS_DIR` or `<cwd>/scripts`. */
    root?: string;
    /** Execution timeout, ms. Defaults to `$INFAGENT_SCRIPT_TIMEOUT_MS` or 30000. */
    timeoutMs?: number;
    /** Allow `runScript()`. Defaults to `$INFAGENT_ALLOW_RUN !== '0'`. */
    allowRun?: boolean;
}
declare function nowIso(): string;
export declare class ScriptRegistry {
    readonly root: string;
    private readonly timeoutMs;
    private readonly allowRun;
    constructor(options?: ScriptRegistryOptions);
    /**
     * Create the folder on first use so a fresh checkout just works, and drop an
     * ESM marker so agent-authored `.js` scripts (`export function run`, top-level
     * `import.meta.url`) execute as ES modules even when the folder is copied
     * outside this package.
     */
    ensureRoot(): string;
    private assertName;
    private fileForName;
    private toRecord;
    /** `listScripts()` — every managed script, sorted by name. */
    list(): ScriptRecord[];
    /** `readScript(name)` — metadata plus the full source. */
    read(name: string): ScriptDetail;
    /** `describeScript(name)` — the parsed header only. */
    describe(name: string): ScriptMeta;
    /** `createScript({...})` — write a new script with a generated header. */
    create(input: CreateScriptInput): ScriptDetail;
    /** `updateScript(name, patch)` — rewrite header and/or body in place. */
    update(name: string, patch: UpdateScriptInput): ScriptDetail;
    private bodyStartLine;
    /** `removeScript(name)` — delete the file; returns what was removed. */
    remove(name: string): {
        name: string;
        file: string;
        relativePath: string;
        language: ScriptLanguage;
    };
    /** `searchScripts(query)` — match name, description or agent prompt. */
    search(query: string): ScriptRecord[];
    /** `runScript(name, args)` — execute with JSON args, return the envelope. */
    run(name: string, args?: Record<string, unknown>): Promise<ScriptRunResult>;
    /** `scriptStats()` — counters for dashboards. */
    stats(): ScriptStats;
    /** The ready-to-paste prompt telling an agent how to call this script. */
    agentPrompt(name: string): string;
    /** JSON-schema tool definitions an LLM can be handed directly. */
    toolDefinitions(): ToolDefinition[];
    /** System prompt describing the whole toolbox, for pasting into an LLM. */
    systemPrompt(): string;
    /** Human-readable table used by the CLI. */
    format(): string;
}
/** Default registry bound to `<cwd>/scripts`, used by the free functions below. */
export declare const defaultRegistry: ScriptRegistry;
export declare const listScripts: () => ScriptRecord[];
export declare const readScript: (name: string) => ScriptDetail;
export declare const describeScript: (name: string) => ScriptMeta;
export declare const createScript: (input: CreateScriptInput) => ScriptDetail;
export declare const updateScript: (name: string, patch: UpdateScriptInput) => ScriptDetail;
export declare const removeScript: (name: string) => ReturnType<ScriptRegistry["remove"]>;
export declare const searchScripts: (query: string) => ScriptRecord[];
export declare const runScript: (name: string, args?: Record<string, unknown>) => Promise<ScriptRunResult>;
export declare const scriptStats: () => ScriptStats;
export declare const scriptAgentPrompt: (name: string) => string;
export declare const scriptTools: () => ToolDefinition[];
export declare const scriptSystemPrompt: () => string;
export { nowIso };
//# sourceMappingURL=registry.d.ts.map
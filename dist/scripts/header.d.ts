import type { ScriptLanguage, ScriptMeta, ScriptParam } from './types.js';
export declare const HEADER_VERSION = "infagent-script/v1";
declare const ORDERED_KEYS: readonly ["version", "name", "language", "description", "callback", "usage", "params"];
/** Render a header block for the given language. */
export declare function buildHeader(meta: ScriptMeta, options?: {
    js?: boolean;
}): string;
export interface ParsedHeader {
    meta: ScriptMeta;
    /** True when a valid `@infagent-script` block was found. */
    found: boolean;
    /** Line index where the body starts. */
    bodyStart: number;
}
/**
 * Extract the header from a script source. Falls back to a minimal meta built
 * from the file name when the header is missing or malformed, so tooling keeps
 * working with hand-written scripts.
 */
export declare function parseHeader(source: string, language: ScriptLanguage, name: string): ParsedHeader;
export declare function defaultUsage(name: string, language: ScriptLanguage): string;
export declare function defaultAgentPrompt(name: string, description: string, params: ScriptParam[]): string;
/** Body template for a new script: exports `run()` and prints the JSON envelope. */
export declare function defaultBody(name: string, language: ScriptLanguage, description: string): string;
/** Compose a complete script file from metadata. */
export declare function composeScript(meta: ScriptMeta, body?: string): string;
export { ORDERED_KEYS };
//# sourceMappingURL=header.d.ts.map
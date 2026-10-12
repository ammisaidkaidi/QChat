import type { ScriptLanguage, ScriptRunResult } from './types.js';
export interface RunScriptOptions {
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Override the interpreter, e.g. `python3`. */
    binary?: string;
}
/** The Python to use: the override, else the first interpreter that answers. */
export declare function pythonInterpreter(): string;
export declare function interpreterFor(language: ScriptLanguage): string;
export declare function commandLabel(language: ScriptLanguage, file: string, args: Record<string, unknown>): string;
export declare function runScriptFile(file: string, language: ScriptLanguage, name: string, args?: Record<string, unknown>, options?: RunScriptOptions): Promise<ScriptRunResult>;
//# sourceMappingURL=runner.d.ts.map
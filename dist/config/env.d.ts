export declare class EnvError extends Error {
    readonly missing: readonly string[];
    constructor(missing: readonly string[]);
}
export interface LoadEnvOptions {
    /** Path to the env file. Defaults to `<cwd>/.env`. */
    path?: string;
    /** Overwrite variables already present in `process.env`. Defaults to `false`. */
    override?: boolean;
    /** Suppress the "no env file" notice. */
    silent?: boolean;
}
export declare function defaultEnvFile(): string;
/**
 * Load `<cwd>/.env` into `process.env` (idempotent, safe to call from anywhere).
 * Existing shell variables always win unless `override` is set.
 *
 * @returns `true` when a file was found and parsed.
 */
export declare function loadEnv(options?: LoadEnvOptions): boolean;
/** Ensure the env file has been loaded exactly once. */
export declare function ensureEnv(options?: LoadEnvOptions): boolean;
export declare function isEnvLoaded(): boolean;
export declare function envSource(): string | undefined;
/** Keys declared in the loaded env file (not the whole system environment). */
export declare function envKeys(): readonly string[];
/** Read a variable, falling back to `fallback` (or `undefined`). */
export declare function getEnv(key: string, fallback: string): string;
export declare function getEnv(key: string, fallback?: string): string | undefined;
/**
 * Read variables that must exist, or throw a single `EnvError` listing all of them.
 * Fails fast at startup instead of exploding on first use.
 */
export declare function requireEnv(...keys: string[]): Record<string, string>;
export declare function getEnvInt(key: string, fallback?: number): number | undefined;
export declare function getEnvBool(key: string, fallback?: boolean): boolean;
/** `true` when the key name looks like it holds a secret. */
export declare function isSensitiveKey(key: string): boolean;
/** Mask a value for logs: `sk-a…4f2a` style, never the full secret. */
export declare function redact(value: string): string;
export interface EnvEntry {
    key: string;
    value: string;
    sensitive: boolean;
}
/**
 * Snapshot the environment, redacting anything that looks sensitive.
 * Handy for `--json` diagnostics and bug reports.
 */
export declare function snapshot(keys?: readonly string[]): EnvEntry[];
/** Reset internal bookkeeping (used by tests). Does not touch `process.env`. */
export declare function resetEnvState(): void;
//# sourceMappingURL=env.d.ts.map
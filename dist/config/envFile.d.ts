/** Shown in place of a secret value. */
export declare const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022";
export declare class EnvFileError extends Error {
    readonly code: 'bad_request' | 'io';
    constructor(code: 'bad_request' | 'io', message: string);
}
export interface EnvFileEntry {
    key: string;
    /** The real value, unless the key is a secret — then `null`. */
    value: string | null;
    /** What the interface shows in the value column. */
    masked: string;
    secret: boolean;
    /** False when the key is declared but has no value yet. */
    set: boolean;
    /** Section name from the reference file, e.g. "database (Supabase pooler)". */
    group: string;
    /** The comment that sits above the key in the reference file. */
    note: string;
}
export interface EnvFileSnapshot {
    path: string;
    exists: boolean;
    entries: EnvFileEntry[];
}
interface ParsedLine {
    kind: 'entry' | 'comment' | 'blank' | 'other';
    raw: string;
    key?: string;
    value?: string;
}
export declare function isSecretKey(key: string): boolean;
export declare function isEnvKey(key: string): boolean;
export declare function maskValue(): string;
/** Quote only when the value would otherwise be mangled by a shell or dotenv. */
export declare function formatEnvValue(value: string): string;
export declare function parseEnv(text: string): ParsedLine[];
/**
 * Apply updates to the parsed file, keeping every comment, blank line and
 * ordering. Keys that are not in the file yet are appended together at the end.
 */
/** Marker the console writes above keys it added. */
export declare const ADDED_BANNER = "# ---- added from the console ----";
export declare function renderEnv(lines: ParsedLine[], updates: Map<string, string>, remove: Set<string>): string;
export interface EnvReference {
    group: string;
    note: string;
}
/** Key → section/comment, read from the committed reference file. */
export declare function parseReference(text: string): Map<string, EnvReference>;
export declare function readEnvFile(path: string, referenceText?: string): EnvFileSnapshot;
/**
 * The plaintext of one key, or `null` when the file does not set it.
 *
 * This is the only way a secret value can leave this module, and it exists for
 * the console's explicit *reveal* action: one key at a time, on the user's
 * click, never logged and never part of a snapshot.
 */
export declare function readEnvValue(path: string, key: string): string | null;
/**
 * Every credential the file sets, for the console's "reveal all" switch.
 *
 * Same rule as `readEnvValue`: only on an explicit request, never in a
 * snapshot, never logged. Keys that are declared but empty are skipped, so the
 * result is exactly what "reveal" would show one key at a time.
 */
export declare function readEnvSecrets(path: string): Record<string, string>;
export interface EnvWriteResult {
    path: string;
    changed: string[];
    removed: string[];
    backup: string | null;
}
/**
 * Merge `updates` (and optional `remove` keys) into the file, keeping a backup.
 * `process.env` is updated in place so the running server sees new values
 * immediately; servers that were already started keep the old ones until they
 * are restarted from the MCP tab.
 */
export declare function writeEnvFile(path: string, options?: {
    updates?: Record<string, string>;
    remove?: string[];
}): EnvWriteResult;
export {};
//# sourceMappingURL=envFile.d.ts.map
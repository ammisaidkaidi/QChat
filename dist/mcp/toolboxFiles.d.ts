import type { McpManager } from './manager.js';
/** Where tool files live when `mcp.json` says nothing. */
export declare const DEFAULT_TOOLBOX_ROOT: string;
/** The caps the toolbox server enforces; the interface keeps the same ones. */
export declare const TOOLBOX_MAX_BYTES = 65536;
export declare const TOOLBOX_MAX_FILES = 32;
export declare class ToolboxError extends Error {
    readonly code: 'bad_request' | 'not_found' | 'conflict' | 'io';
    constructor(code: ToolboxError['code'], message: string);
}
export interface ToolboxFile {
    name: string;
    bytes: number;
    /** ISO timestamp of the last write. */
    mtime: string;
}
/** The root the `toolbox` entry in `mcp.json` points at, resolved. */
export declare function toolboxRoot(mcp: McpManager | null): string;
/** A tool file name, or a refusal that says exactly what is wrong with it. */
export declare function checkName(raw: unknown): string;
export declare class ToolboxFiles {
    readonly root: string;
    constructor(root: string);
    /** Create the folder if it is missing; a tool folder is cheap to make. */
    ensureRoot(): void;
    /**
     * The absolute path of one tool file, or a refusal.
     *
     * A name that arrives with a path in it has already been rejected by
     * `checkName`; this is the second lock — after resolution the path must still
     * be inside the root, which is what stops a symlinked folder from taking a
     * write somewhere else.
     */
    pathFor(raw: unknown, { mustExist }?: {
        mustExist?: boolean;
    }): string;
    /** Every tool file in the folder, newest last. */
    list(): ToolboxFile[];
    read(raw: unknown): {
        name: string;
        content: string;
        bytes: number;
        mtime: string;
    };
    /** Write a file, creating it if needed, within every cap the server has. */
    write(raw: unknown, content: unknown): ToolboxFile;
    remove(raw: unknown): ToolboxFile;
}
//# sourceMappingURL=toolboxFiles.d.ts.map
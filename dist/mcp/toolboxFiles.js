/**
 * The files behind the toolbox MCP server (`mcp/servers/toolbox.mjs`).
 *
 * This is the piece the console's Toolbox tab talks to: it lists, reads,
 * writes and removes tool files under the root the `toolbox` server was
 * configured with in `mcp.json`, and nothing else. The rules here mirror the
 * server's own — one file, one default export, a plain name, a size cap — so a
 * file that the interface accepts is a file the server will load.
 *
 * Confinement is by realpath: the root is resolved once, every candidate path
 * is resolved again and must still start with it, and a symlink is refused
 * rather than followed. Writes are atomic (a temporary file plus a rename), so
 * a crash mid-save cannot leave a half-written tool behind.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Where tool files live when `mcp.json` says nothing. */
export const DEFAULT_TOOLBOX_ROOT = join(REPO_ROOT, 'mcp', 'tools');
/** The caps the toolbox server enforces; the interface keeps the same ones. */
export const TOOLBOX_MAX_BYTES = 65536;
export const TOOLBOX_MAX_FILES = 32;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}\.(js|mjs)$/i;
export class ToolboxError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ToolboxError';
        this.code = code;
    }
}
/** The root the `toolbox` entry in `mcp.json` points at, resolved. */
export function toolboxRoot(mcp) {
    const entry = mcp?.list().find((server) => server.name === 'toolbox');
    const raw = entry?.args?.[1];
    let root = DEFAULT_TOOLBOX_ROOT;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed.root === 'string' && parsed.root.trim()) {
                root = resolve(REPO_ROOT, parsed.root.trim());
            }
        }
        catch {
            // A config that is not JSON is the MCP tab's problem to show; the
            // interface falls back to the default folder instead of failing.
        }
    }
    return root;
}
/** A tool file name, or a refusal that says exactly what is wrong with it. */
export function checkName(raw) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name)
        throw new ToolboxError('bad_request', 'A file name is required.');
    if (name.includes('\0') || name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new ToolboxError('bad_request', `"${name}" is not a file name.`);
    }
    if (name.startsWith('.')) {
        throw new ToolboxError('bad_request', `"${name}" is hidden; tool files are visible files.`);
    }
    if (!NAME_PATTERN.test(name)) {
        throw new ToolboxError('bad_request', `"${name}" must end in .js or .mjs and be a plain name.`);
    }
    return name;
}
export class ToolboxFiles {
    root;
    constructor(root) {
        this.root = resolve(root);
    }
    /** Create the folder if it is missing; a tool folder is cheap to make. */
    ensureRoot() {
        try {
            mkdirSync(this.root, { recursive: true });
        }
        catch (error) {
            throw new ToolboxError('io', `Could not create ${this.root}: ${error.message}`);
        }
    }
    /**
     * The absolute path of one tool file, or a refusal.
     *
     * A name that arrives with a path in it has already been rejected by
     * `checkName`; this is the second lock — after resolution the path must still
     * be inside the root, which is what stops a symlinked folder from taking a
     * write somewhere else.
     */
    pathFor(raw, { mustExist = false } = {}) {
        const name = checkName(raw);
        const candidate = join(this.root, name);
        if (existsSync(candidate)) {
            const real = realpathSync(candidate);
            const root = existsSync(this.root) ? realpathSync(this.root) : this.root;
            if (real !== join(root, name)) {
                throw new ToolboxError('bad_request', `"${name}" is not a plain file in ${this.root}.`);
            }
            if (!statSync(real).isFile()) {
                throw new ToolboxError('bad_request', `"${name}" is not a file.`);
            }
            return real;
        }
        if (mustExist)
            throw new ToolboxError('not_found', `No tool file named "${name}".`);
        if (!candidate.startsWith(this.root.endsWith(sep) ? this.root : `${this.root}${sep}`)) {
            throw new ToolboxError('bad_request', `"${name}" would land outside ${this.root}.`);
        }
        return candidate;
    }
    /** Every tool file in the folder, newest last. */
    list() {
        if (!existsSync(this.root))
            return [];
        const files = [];
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith('.'))
                continue;
            if (!NAME_PATTERN.test(entry.name))
                continue;
            const stat = statSync(join(this.root, entry.name));
            files.push({
                name: entry.name,
                bytes: stat.size,
                mtime: new Date(stat.mtimeMs).toISOString(),
            });
        }
        return files.sort((a, b) => a.name.localeCompare(b.name));
    }
    read(raw) {
        const path = this.pathFor(raw, { mustExist: true });
        const stat = statSync(path);
        return {
            name: raw,
            content: readFileSync(path, 'utf8'),
            bytes: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString(),
        };
    }
    /** Write a file, creating it if needed, within every cap the server has. */
    write(raw, content) {
        const name = checkName(raw);
        if (typeof content !== 'string') {
            throw new ToolboxError('bad_request', 'The file content must be a string.');
        }
        if (content.includes('\0')) {
            throw new ToolboxError('bad_request', 'The content holds a NUL byte: tool files are text.');
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > TOOLBOX_MAX_BYTES) {
            throw new ToolboxError('bad_request', `${name} would be ${bytes} bytes; the limit is ${TOOLBOX_MAX_BYTES}.`);
        }
        this.ensureRoot();
        const path = this.pathFor(name);
        if (!existsSync(path) && this.list().length >= TOOLBOX_MAX_FILES) {
            throw new ToolboxError('conflict', `The toolbox already holds ${TOOLBOX_MAX_FILES} files.`);
        }
        // Atomic: a half-written tool file must never be importable.
        const temporary = join(dirname(path), `.${name}.saving`);
        try {
            writeFileSync(temporary, content, 'utf8');
            renameSync(temporary, path);
        }
        catch (error) {
            try {
                if (existsSync(temporary))
                    unlinkSync(temporary);
            }
            catch {
                // Leaving the temporary file behind is not worth failing the save twice.
            }
            throw new ToolboxError('io', `Could not write ${name}: ${error.message}`);
        }
        const stat = statSync(path);
        return { name, bytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() };
    }
    remove(raw) {
        const path = this.pathFor(raw, { mustExist: true });
        const stat = statSync(path);
        try {
            unlinkSync(path);
        }
        catch (error) {
            throw new ToolboxError('io', `Could not remove ${raw}: ${error.message}`);
        }
        return {
            name: raw,
            bytes: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString(),
        };
    }
}
//# sourceMappingURL=toolboxFiles.js.map
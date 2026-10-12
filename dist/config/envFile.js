/**
 * Reading and writing the project's `.env` file.
 *
 * The console's Config tab edits `.env` through this module, and three rules
 * shape it:
 *
 *   - **A secret never leaves the server.** Values whose key looks like a
 *     credential are reported as `set` plus a mask; the value itself is not in
 *     the JSON, so it cannot end up in a browser, a log or a screenshot.
 *   - **A malformed line never reaches the file.** Keys are validated, values
 *     are quoted when they need it, and the file is written atomically.
 *   - **A write never destroys the previous contents.** The old file is kept
 *     next to it as `.env.bak`.
 *
 * Editing is what the tab is for, so writes are allowed by default; they are
 * still explicit (a `PUT` with the keys to change) and never touch any other
 * file.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync, } from 'node:fs';
import process from 'node:process';
/** Shown in place of a secret value. */
export const MASK = '••••••';
/** Keys whose values are credentials rather than configuration. */
const SECRET_PATTERN = /(TOKEN|SECRET|PASSWORD|PASS|API_?KEY|PRIVATE|CREDENTIAL|_URL\b)/i;
/** What a shell would accept as a variable name. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_PATTERN = /^#\s*-{2,}\s*(.+?)\s*-{2,}$/;
const BANNER_PATTERN = /^#\s*(generated|committed|sole source|never commit|\.env|edit )/i;
export class EnvFileError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'EnvFileError';
        this.code = code;
    }
}
export function isSecretKey(key) {
    return SECRET_PATTERN.test(key);
}
export function isEnvKey(key) {
    return KEY_PATTERN.test(key);
}
export function maskValue() {
    return MASK;
}
/**
 * Strip the quotes and the trailing comment a shell would ignore.
 *
 * `"two words" # note` is a quoted value followed by a comment, so the closing
 * quote has to be found rather than assumed to be the last character.
 */
function unquote(raw) {
    const value = raw.trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        let body = '';
        for (let index = 1; index < value.length; index += 1) {
            const char = value[index];
            if (char === '\\' && quote === '"' && index + 1 < value.length) {
                const escaped = value[index + 1];
                body += escaped === 'n' ? '\n' : escaped;
                index += 1;
                continue;
            }
            if (char === quote)
                break;
            body += char;
        }
        return body;
    }
    const comment = value.search(/\s#/);
    return (comment === -1 ? value : value.slice(0, comment)).trim();
}
/** Quote only when the value would otherwise be mangled by a shell or dotenv. */
export function formatEnvValue(value) {
    if (value === '')
        return '';
    if (/^[A-Za-z0-9_@./:+-]*$/.test(value))
        return value;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
export function parseEnv(text) {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw) => {
        const line = raw.trim();
        if (!line)
            return { kind: 'blank', raw };
        if (line.startsWith('#'))
            return { kind: 'comment', raw };
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (!match)
            return { kind: 'other', raw };
        return {
            kind: 'entry',
            raw,
            key: match[1],
            value: unquote(match[2] ?? ''),
        };
    });
}
/**
 * Apply updates to the parsed file, keeping every comment, blank line and
 * ordering. Keys that are not in the file yet are appended together at the end.
 */
/** Marker the console writes above keys it added. */
export const ADDED_BANNER = '# ---- added from the console ----';
export function renderEnv(lines, updates, remove) {
    const applied = new Set();
    const kept = [];
    for (const line of lines) {
        if (line.kind === 'entry' && line.key) {
            if (remove.has(line.key))
                continue;
            const next = updates.get(line.key);
            if (next !== undefined) {
                applied.add(line.key);
                kept.push(`${line.key}=${formatEnvValue(next)}`);
                continue;
            }
        }
        kept.push(line.raw);
    }
    const added = [...updates.entries()].filter(([key]) => !applied.has(key) && !remove.has(key));
    if (added.length > 0) {
        // A brand-new file needs no separator or banner, an existing one does.
        if (kept.some((line) => line.trim() !== '')) {
            if (kept[kept.length - 1]?.trim() !== '')
                kept.push('');
            kept.push(ADDED_BANNER);
        }
        else {
            kept.length = 0;
        }
        for (const [key, value] of added)
            kept.push(`${key}=${formatEnvValue(value)}`);
    }
    // Removing the last console-added key would leave the banner behind.
    for (let index = kept.length - 1; index >= 0; index -= 1) {
        const line = kept[index]?.trim();
        if (line === '')
            continue;
        if (line === ADDED_BANNER)
            kept.length = index;
        break;
    }
    return `${kept.join('\n').replace(/\n+$/, '')}\n`;
}
function entriesFrom(lines) {
    const found = new Map();
    for (const line of lines) {
        if (line.kind === 'entry' && line.key)
            found.set(line.key, line.value ?? '');
    }
    return found;
}
/** Key → section/comment, read from the committed reference file. */
export function parseReference(text) {
    const map = new Map();
    let group = '';
    let note = '';
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trim();
        if (!line) {
            note = '';
            continue;
        }
        if (line.startsWith('#')) {
            const heading = GROUP_PATTERN.exec(line);
            if (heading?.[1]) {
                group = heading[1].trim();
                note = '';
                continue;
            }
            const text = line.replace(/^#+\s?/, '').trim();
            note = BANNER_PATTERN.test(line) ? '' : text;
            continue;
        }
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match?.[1])
            map.set(match[1], { group, note });
        note = '';
    }
    return map;
}
export function readEnvFile(path, referenceText = '') {
    const exists = existsSync(path);
    const text = exists ? readFileSync(path, 'utf8') : '';
    const values = entriesFrom(parseEnv(text));
    const reference = parseReference(referenceText);
    // Reference keys the file does not mention yet are listed too, so the tab
    // shows the whole configuration instead of only what happens to be set.
    const keys = new Set([...values.keys(), ...reference.keys()]);
    const entries = [...keys].map((key) => {
        const secret = isSecretKey(key);
        const value = values.get(key);
        const set = value !== undefined && value !== '';
        const info = reference.get(key);
        return {
            key,
            value: secret ? null : (value ?? ''),
            masked: secret ? (set ? MASK : '') : (value ?? ''),
            secret,
            set,
            group: info?.group ?? 'from your .env',
            note: info?.note ?? '',
        };
    });
    return { path, exists, entries };
}
/**
 * Merge `updates` (and optional `remove` keys) into the file, keeping a backup.
 * `process.env` is updated in place so the running server sees new values
 * immediately; servers that were already started keep the old ones until they
 * are restarted from the MCP tab.
 */
export function writeEnvFile(path, options = {}) {
    const updates = new Map();
    for (const [key, value] of Object.entries(options.updates ?? {})) {
        if (!isEnvKey(key)) {
            throw new EnvFileError('bad_request', `"${key}" is not a valid environment variable name.`);
        }
        if (typeof value !== 'string') {
            throw new EnvFileError('bad_request', `The value for ${key} must be a string.`);
        }
        if (value.includes('\0')) {
            throw new EnvFileError('bad_request', `The value for ${key} contains a NUL byte.`);
        }
        updates.set(key, value);
    }
    const remove = new Set();
    for (const key of options.remove ?? []) {
        if (!isEnvKey(key)) {
            throw new EnvFileError('bad_request', `"${key}" is not a valid environment variable name.`);
        }
        remove.add(key);
    }
    const exists = existsSync(path);
    const previous = exists ? readFileSync(path, 'utf8') : '';
    const next = renderEnv(parseEnv(previous), updates, remove);
    let backup = null;
    if (exists) {
        backup = `${path}.bak`;
        copyFileSync(path, backup);
        chmodSync(backup, 0o600);
    }
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, next, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    for (const [key, value] of updates)
        process.env[key] = value;
    for (const key of remove)
        delete process.env[key];
    return { path, changed: [...updates.keys()], removed: [...remove], backup };
}
//# sourceMappingURL=envFile.js.map
/**
 * Tool-call parsing and dispatch.
 *
 * A 0.6B model does not always follow one canonical shape, so the parser accepts
 * every form Qwen3 emits in practice:
 *
 *   1. `<tool_call>{"name":"runScript","arguments":{"name":"hello","args":{…}}}</tool_call>`
 *   2. `<tool_call>{"name":"hello","args":{…}}</tool_call>`   ← the common one
 *   3. a bare `<tool_call>{ "name": "listScripts" }</tool_call>`
 *   4. `[{"name":"listScripts","arguments":{}}]` — the Hammer2.1 / xLAM shape,
 *      either bare or inside the XML tags
 *
 * Dispatch order: built-in callbacks first (`listScripts`, `createScript`, …),
 * then a registered script called by name, then `runScript` with a nested name.
 */
import { AlertError, asAlertInput } from '../capabilities/alerts.js';
import { webFetch, webSearch, WebError } from '../capabilities/search.js';
import { SCRIPT_NAME_PATTERN, ScriptError } from '../scripts/registry.js';
import { asSkillInput, SkillError } from '../skills/registry.js';
import { trimText } from './prompt.js';
/**
 * Walk `text` and return every balanced `open…close` slice, string literals
 * respected. Used to lift JSON out of a reply that carries no XML tags at all.
 */
function findBalanced(text, open, close) {
    const found = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"')
            inString = true;
        else if (char === open) {
            if (depth === 0)
                start = index;
            depth += 1;
        }
        else if (char === close && depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                found.push({ raw: text.slice(start, index + 1), index: start });
                start = -1;
            }
        }
    }
    return found;
}
/** Every balanced `{…}` slice. */
function findJsonObjects(text) {
    return findBalanced(text, '{', '}');
}
/** Every balanced `[…]` slice. */
function findJsonArrays(text) {
    return findBalanced(text, '[', ']');
}
const TOOL_CALL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/gi;
export const BUILTIN_TOOLS = [
    'listScripts',
    'searchScripts',
    'readScript',
    'describeScript',
    'createScript',
    'updateScript',
    'removeScript',
    'runScript',
    'scriptStats',
    'webSearch',
    'webFetch',
    'listSkills',
    'readSkill',
    'createSkill',
    'showAlert',
];
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Extract candidate calls from a model reply.
 * Returns the calls plus the reply text with the blocks removed, so the UI can
 * show only the human-readable remainder.
 */
export function extractToolCalls(text, options = {}) {
    const knownScripts = options.knownScripts ?? [];
    const calls = [];
    const seen = new Set();
    const consider = (candidate) => {
        let record = asRecord(candidate);
        if (!record)
            return;
        // The strict-JSON envelope, salvaged: a model that wrapped
        // `{"type":"tool_call","calls":[…]}` in prose or a fence has already failed
        // the parser, and the calls inside it are still the ones it meant.
        if (typeof record['type'] === 'string' && Array.isArray(record['calls'])) {
            for (const entry of record['calls'])
                consider(entry);
            return;
        }
        // Qwen3 sometimes emits `{"listScripts": {}}` — or `{"list_scripts": […]}`
        // with the answer already inside — instead of the documented
        // `{"name": …, "arguments": …}` shape. Only real tool names qualify, so a
        // stray JSON object in prose is never mistaken for a call.
        if (typeof record['name'] !== 'string') {
            const keys = Object.keys(record);
            const [key] = keys;
            if (keys.length === 1 && key !== undefined && isToolName(key, knownScripts, true)) {
                const value = record[key];
                record = {
                    name: key,
                    args: value !== null && typeof value === 'object' ? value : {},
                };
            }
        }
        const name = typeof record['name'] === 'string' ? record['name'] : undefined;
        if (!name)
            return;
        // Tolerate `arguments`, `args`, `parameters` and `input`.
        const args = asRecord(record['arguments']) ??
            asRecord(record['args']) ??
            asRecord(record['parameters']) ??
            asRecord(record['input']) ??
            {};
        const key = `${name}:${JSON.stringify(args)}`;
        if (seen.has(key))
            return;
        seen.add(key);
        calls.push({ name, args });
    };
    const scan = (value) => {
        try {
            const parsed = JSON.parse(value.trim());
            // Hammer2.1 / xLAM answer with an array of calls, sometimes still wrapped
            // in the Qwen3 tags.
            if (Array.isArray(parsed))
                parsed.forEach(consider);
            else
                consider(parsed);
            return;
        }
        catch {
            /* fall through to the lenient pass */
        }
        // Tolerate trailing prose/semicolons inside the block.
        const match = /\{[\s\S]*\}/.exec(value);
        if (match) {
            try {
                consider(JSON.parse(match[0]));
            }
            catch {
                /* ignore malformed blocks */
            }
        }
    };
    // Salvage an unterminated block: the model often stops right after the JSON
    // (no `</tool_call>`), and the call would otherwise be lost.
    let tail = '';
    const lastOpen = text.lastIndexOf('<tool_call>');
    if (lastOpen !== -1 && text.lastIndexOf('</tool_call>') < lastOpen) {
        const body = text.slice(lastOpen + '<tool_call>'.length);
        if (body.trim().startsWith('{')) {
            scan(body);
            tail = text.slice(0, lastOpen);
        }
    }
    let rest = (tail || text).replace(TOOL_CALL_BLOCK, (_full, body) => {
        scan(body);
        return '';
    });
    if (calls.length === 0)
        rest = text;
    if (calls.length === 0) {
        // Hammer2.1 and xLAM emit exactly one JSON array and nothing else, e.g.
        // `[{"name": "runScript", "arguments": {"name": "hello"}}]`. Every entry has
        // to name a real tool, so a list of strings in prose is never a call.
        const outerObjects = findJsonObjects(rest);
        for (const candidate of findJsonArrays(rest)) {
            // Skip an array that sits *inside* a JSON object: that object is itself a
            // candidate call (`{"list_scripts": [...]}`), and it is the outer value
            // the model meant.
            const nested = outerObjects.some((object) => candidate.index >= object.index &&
                candidate.index + candidate.raw.length <= object.index + object.raw.length);
            if (nested)
                continue;
            try {
                const parsed = JSON.parse(candidate.raw);
                if (!Array.isArray(parsed) || parsed.length === 0)
                    continue;
                // Keep only the entries that name a real tool: an array with no
                // addressed call at all is prose, not a request.
                const addressed = parsed.filter((entry) => {
                    const record = asRecord(entry);
                    const name = record?.['name'];
                    return typeof name === 'string' && isToolName(name, knownScripts, true);
                });
                if (addressed.length === 0)
                    continue;
                for (const entry of addressed)
                    consider(entry);
                if (calls.length > 0) {
                    rest = `${rest.slice(0, candidate.index)}${rest.slice(candidate.index + candidate.raw.length)}`;
                    break;
                }
            }
            catch {
                /* not JSON — keep scanning */
            }
        }
    }
    if (calls.length === 0) {
        // Last resort: the model sometimes emits the call with no tags at all (or
        // drops the opening one), e.g. `{"name": "listScripts", "arguments": {}}`
        // or `{"list_scripts": […]}`.
        // Only names that are real tools are accepted, so prose stays intact.
        for (const candidate of findJsonObjects(rest)) {
            try {
                const parsed = JSON.parse(candidate.raw);
                const before = calls.length;
                consider(parsed);
                {
                    if (calls.length > before) {
                        // Remove the JSON (and any stray tag around it) from the reply.
                        const before = rest.slice(0, candidate.index);
                        const after = rest.slice(candidate.index + candidate.raw.length);
                        rest = `${before}${after}`.replace(/<\/?tool_call>/gi, '');
                        break;
                    }
                }
            }
            catch {
                /* not JSON — keep scanning */
            }
        }
    }
    if (calls.length === 0) {
        // No explicit block: accept a fenced JSON object naming a callable tool.
        rest = rest.replace(FENCED_JSON, (full, body) => {
            try {
                const parsed = JSON.parse(body.trim());
                const record = asRecord(parsed);
                const name = record?.['name'];
                if (typeof name === 'string' && BUILTIN_TOOLS.includes(name)) {
                    consider(record);
                    return '';
                }
            }
            catch {
                /* keep the fence when it is not a tool call */
            }
            return full;
        });
    }
    return { calls, rest };
}
/**
 * Is this a name the toolbox actually answers to?
 *
 * `strict` drops the "looks like a script name" fallback, which is what the
 * loose `{"toolName": {...}}` shape needs so prose JSON is never a call.
 */
function isToolName(name, knownScripts, strict = false) {
    const normalize = (value) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const target = normalize(name);
    const matches = BUILTIN_TOOLS.some((tool) => normalize(tool) === target) ||
        knownScripts.some((script) => normalize(script) === target);
    // MCP names are `server__tool`, which the normaliser folds to `servertool`.
    if (name.includes('__'))
        return true;
    return matches || (!strict && SCRIPT_NAME_PATTERN.test(name));
}
/**
 * Repair the tool name a small model produced.
 *
 * `list_scripts`, `listscripts` and `ListScripts` all mean `listScripts`; the
 * same holds for script names in the registry. Without this the call fails with
 * "unknown tool" and the model has to guess its way back.
 */
function resolveToolName(raw, registry) {
    const builtins = BUILTIN_TOOLS;
    if (builtins.includes(raw))
        return raw;
    const scriptNames = registry.list().map((record) => record.meta.name);
    if (scriptNames.includes(raw))
        return raw;
    const normalize = (value) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const target = normalize(raw);
    const match = [...builtins, ...scriptNames].find((candidate) => normalize(candidate) === target);
    return match ?? raw;
}
/** The payload of an MCP call: its JSON answer when it has one, text otherwise. */
function mcpPayload(server, tool, text, isError) {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return {
                server,
                tool,
                ...parsed,
                ...(isError ? { isError } : {}),
            };
        }
        return { server, tool, output: parsed, ...(isError ? { isError } : {}) };
    }
    catch {
        return { server, tool, output: raw, ...(isError ? { isError } : {}) };
    }
}
/** Execute one parsed call against the script toolbox. */
export async function dispatchTool(call, options) {
    const { registry } = options;
    const allowRun = options.allowRun ?? true;
    const net = options.net ?? false;
    const startedAt = Date.now();
    const finish = (result) => ({
        ...result,
        durationMs: Date.now() - startedAt,
    });
    try {
        const name = resolveToolName(call.name, registry);
        // A script called directly by name (`{"name":"hello","args":{…}}`).
        if (!BUILTIN_TOOLS.includes(name) && SCRIPT_NAME_PATTERN.test(name)) {
            const known = registry.list().some((record) => record.meta.name === name);
            if (known) {
                if (!allowRun)
                    throw new ScriptError('disabled', 'Script execution is disabled.');
                const run = await registry.run(name, call.args);
                return finish({
                    name,
                    args: call.args,
                    ok: run.ok,
                    result: run.envelope ?? {
                        stdout: run.stdout,
                        stderr: run.stderr,
                        exitCode: run.exitCode,
                    },
                    durationMs: run.durationMs,
                });
            }
        }
        // MCP tools are addressed as `server__tool`.
        if (options.mcp && name.includes('__')) {
            const wanted = options.mcpAllowed;
            const called = name.slice(0, name.indexOf('__'));
            if (wanted !== undefined && !wanted.includes(called)) {
                throw new Error(`The MCP server "${called}" is switched off for this chat (the 🔧 picker next to the message box).`);
            }
            const { server, tool, result } = await options.mcp.call(name, call.args);
            // A failed MCP call is reported with the server's own words: "failed:
            // failed" tells the user nothing about what to fix.
            const reason = trimText(String(result.text ?? '').replace(/^\w*Error:\s*/, ''), 200);
            return finish({
                name,
                args: call.args,
                ok: result.ok,
                // Most servers answer with JSON. Passing it through as text wrapped the
                // model's own payload in a string inside a string; the parsed object is
                // what the tool actually said, with the addressing kept alongside.
                result: mcpPayload(server, tool, result.text, result.isError === true),
                ...(result.ok || reason.length === 0 ? {} : { error: reason }),
                durationMs: result.durationMs,
            });
        }
        switch (name) {
            case 'webSearch': {
                if (!net)
                    throw new WebError('disabled', 'Internet access is switched off for this chat.');
                const query = String(call.args['query'] ?? call.args['q'] ?? '');
                const limit = Number(call.args['limit'] ?? 5);
                const report = await webSearch(query, { limit: Number.isFinite(limit) ? limit : 5 });
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: report.results.map((item) => ({
                        title: item.title,
                        url: item.url,
                        snippet: item.snippet,
                    })),
                });
            }
            case 'webFetch': {
                if (!net)
                    throw new WebError('disabled', 'Internet access is switched off for this chat.');
                const url = String(call.args['url'] ?? '');
                const maxChars = Number(call.args['maxChars'] ?? 4000);
                const page = await webFetch(url, { maxChars: Number.isFinite(maxChars) ? maxChars : 4000 });
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: { title: page.title, url: page.url, text: page.text },
                });
            }
            case 'showAlert': {
                const alerts = options.alerts;
                if (!alerts)
                    throw new AlertError('No alert display is attached to this session.');
                const alert = alerts.raise(asAlertInput(call.args), call.args['source'] === undefined ? 'agent' : String(call.args['source']));
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: {
                        shown: true,
                        id: alert.id,
                        level: alert.level,
                        title: alert.title,
                        message: alert.message,
                    },
                });
            }
            case 'listSkills': {
                const skills = options.skills;
                if (!skills)
                    throw new SkillError('invalid', 'No skill library is configured.');
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: skills.list().map((skill) => ({
                        name: skill.meta.name,
                        description: skill.meta.description,
                        when: skill.meta.when,
                    })),
                });
            }
            case 'readSkill': {
                const skills = options.skills;
                if (!skills)
                    throw new SkillError('invalid', 'No skill library is configured.');
                const detail = skills.read(String(call.args['name'] ?? ''));
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: {
                        name: detail.meta.name,
                        description: detail.meta.description,
                        body: detail.body,
                    },
                });
            }
            case 'createSkill': {
                const skills = options.skills;
                if (!skills)
                    throw new SkillError('invalid', 'No skill library is configured.');
                const created = skills.create(asSkillInput({ ...call.args, overwrite: true }));
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: { name: created.meta.name, file: created.relativePath },
                });
            }
            case 'listScripts':
                // Compact projection: the full header blobs drown a 0.6B model in noise.
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: registry.list().map((record) => ({
                        name: record.meta.name,
                        language: record.meta.language,
                        description: record.meta.description,
                        args: record.meta.params.map((param) => param.name),
                    })),
                });
            case 'searchScripts': {
                const query = String(call.args['query'] ?? '');
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: registry.search(query).map((record) => ({
                        name: record.meta.name,
                        language: record.meta.language,
                        description: record.meta.description,
                    })),
                });
            }
            case 'readScript': {
                const record = registry.read(String(call.args['name'] ?? ''));
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: { meta: record.meta, source: record.source },
                });
            }
            case 'describeScript':
                return finish({
                    name,
                    args: call.args,
                    ok: true,
                    result: registry.describe(String(call.args['name'] ?? '')),
                });
            case 'scriptStats':
                return finish({ name, args: call.args, ok: true, result: registry.stats() });
            case 'runScript': {
                const scriptName = String(call.args['name'] ?? call.args['script'] ?? '');
                const scriptArgs = asRecord(call.args['args']) ?? asRecord(call.args['arguments']) ?? {};
                if (!allowRun)
                    throw new ScriptError('disabled', 'Script execution is disabled.');
                const run = await registry.run(scriptName, scriptArgs);
                return finish({
                    name,
                    args: call.args,
                    ok: run.ok,
                    result: run.envelope ?? {
                        stdout: run.stdout,
                        stderr: run.stderr,
                        exitCode: run.exitCode,
                    },
                    durationMs: run.durationMs,
                });
            }
            case 'createScript': {
                const created = registry.create({
                    name: String(call.args['name'] ?? ''),
                    language: call.args['language'] === 'py' ? 'py' : 'js',
                    description: String(call.args['description'] ?? 'Created through chat.'),
                    ...(Array.isArray(call.args['params']) ? { params: call.args['params'] } : {}),
                    overwrite: Boolean(call.args['overwrite']),
                });
                return finish({ name, args: call.args, ok: true, result: created.meta });
            }
            case 'updateScript': {
                const updated = registry.update(String(call.args['name'] ?? ''), {
                    ...(typeof call.args['description'] === 'string'
                        ? { description: call.args['description'] }
                        : {}),
                    ...(typeof call.args['agentPrompt'] === 'string'
                        ? { agentPrompt: call.args['agentPrompt'] }
                        : {}),
                    ...(typeof call.args['body'] === 'string' ? { body: call.args['body'] } : {}),
                });
                return finish({ name, args: call.args, ok: true, result: updated.meta });
            }
            case 'removeScript': {
                const removed = registry.remove(String(call.args['name'] ?? ''));
                return finish({ name, args: call.args, ok: true, result: removed });
            }
            default:
                return finish({ name, args: call.args, ok: false, error: `Unknown tool "${name}".` });
        }
    }
    catch (error) {
        return finish({
            name: call.name,
            args: call.args,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
export { asRecord };
//# sourceMappingURL=tools.js.map
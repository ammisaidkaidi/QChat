/**
 * Tool-call parsing and dispatch.
 *
 * A 0.6B model does not always follow one canonical shape, so the parser accepts
 * every form Qwen3 emits in practice:
 *
 *   1. `<tool_call>{"name":"runScript","arguments":{"name":"hello","args":{…}}}</tool_call>`
 *   2. `<tool_call>{"name":"hello","args":{…}}</tool_call>`   ← the common one
 *   3. a bare `<tool_call>{ "name": "listScripts" }</tool_call>`
 *
 * Dispatch order: built-in callbacks first (`listScripts`, `createScript`, …),
 * then a registered script called by name, then `runScript` with a nested name.
 */
import { SCRIPT_NAME_PATTERN, ScriptError } from '../scripts/registry.js';
import type { ScriptRegistry } from '../scripts/registry.js';
import type { ChatToolCall } from './types.js';

/** Walk `text` and return every balanced `{…}` slice (string literals respected). */
function findJsonObjects(text: string): { raw: string; index: number }[] {
  const found: { raw: string; index: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        found.push({ raw: text.slice(start, index + 1), index: start });
        start = -1;
      }
    }
  }

  return found;
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
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Extract candidate calls from a model reply.
 * Returns the calls plus the reply text with the blocks removed, so the UI can
 * show only the human-readable remainder.
 */
export function extractToolCalls(
  text: string,
  options: { knownScripts?: readonly string[] } = {},
): { calls: ChatToolCall[]; rest: string } {
  const knownScripts = options.knownScripts ?? [];
  const calls: ChatToolCall[] = [];
  const seen = new Set<string>();

  const consider = (candidate: unknown): void => {
    let record = asRecord(candidate);
    if (!record) return;

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
          args:
            value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {},
        };
      }
    }

    const name = typeof record['name'] === 'string' ? record['name'] : undefined;
    if (!name) return;

    // Tolerate `arguments`, `args`, `parameters` and `input`.
    const args =
      asRecord(record['arguments']) ??
      asRecord(record['args']) ??
      asRecord(record['parameters']) ??
      asRecord(record['input']) ??
      {};

    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ name, args });
  };

  const scan = (value: string): void => {
    try {
      consider(JSON.parse(value.trim()));
      return;
    } catch {
      /* fall through to the lenient pass */
    }
    // Tolerate trailing prose/semicolons inside the block.
    const match = /\{[\s\S]*\}/.exec(value);
    if (match) {
      try {
        consider(JSON.parse(match[0]));
      } catch {
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

  let rest = (tail || text).replace(TOOL_CALL_BLOCK, (_full, body: string) => {
    scan(body);
    return '';
  });
  if (calls.length === 0) rest = text;

  if (calls.length === 0) {
    // Last resort: the model sometimes emits the call with no tags at all (or
    // drops the opening one), e.g. `{"name": "listScripts", "arguments": {}}`
    // or `{"list_scripts": […]}`.
    // Only names that are real tools are accepted, so prose stays intact.
    for (const candidate of findJsonObjects(rest)) {
      try {
        const parsed: unknown = JSON.parse(candidate.raw);
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
      } catch {
        /* not JSON — keep scanning */
      }
    }
  }

  if (calls.length === 0) {
    // No explicit block: accept a fenced JSON object naming a callable tool.
    rest = rest.replace(FENCED_JSON, (full, body: string) => {
      try {
        const parsed: unknown = JSON.parse(body.trim());
        const record = asRecord(parsed);
        const name = record?.['name'];
        if (typeof name === 'string' && (BUILTIN_TOOLS as readonly string[]).includes(name)) {
          consider(record);
          return '';
        }
      } catch {
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
function isToolName(name: string, knownScripts: readonly string[], strict = false): boolean {
  const normalize = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const target = normalize(name);
  const matches =
    (BUILTIN_TOOLS as readonly string[]).some((tool) => normalize(tool) === target) ||
    knownScripts.some((script) => normalize(script) === target);
  return matches || (!strict && SCRIPT_NAME_PATTERN.test(name));
}

/**
 * Repair the tool name a small model produced.
 *
 * `list_scripts`, `listscripts` and `ListScripts` all mean `listScripts`; the
 * same holds for script names in the registry. Without this the call fails with
 * "unknown tool" and the model has to guess its way back.
 */
function resolveToolName(raw: string, registry: ScriptRegistry): string {
  const builtins = BUILTIN_TOOLS as readonly string[];
  if (builtins.includes(raw)) return raw;

  const scriptNames = registry.list().map((record) => record.meta.name);
  if (scriptNames.includes(raw)) return raw;

  const normalize = (value: string): string => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const target = normalize(raw);
  const match = [...builtins, ...scriptNames].find((candidate) => normalize(candidate) === target);
  return match ?? raw;
}

export interface DispatchOptions {
  registry: ScriptRegistry;
  /** Allow `runScript` and script execution at all. */
  allowRun?: boolean;
}

/** Execute one parsed call against the script toolbox. */
export async function dispatchTool(
  call: ChatToolCall,
  options: DispatchOptions,
): Promise<ChatToolCall> {
  const { registry } = options;
  const allowRun = options.allowRun ?? true;
  const startedAt = Date.now();

  const finish = (result: ChatToolCall): ChatToolCall => ({
    ...result,
    durationMs: Date.now() - startedAt,
  });

  try {
    const name = resolveToolName(call.name, registry);

    // A script called directly by name (`{"name":"hello","args":{…}}`).
    if (!(BUILTIN_TOOLS as readonly string[]).includes(name) && SCRIPT_NAME_PATTERN.test(name)) {
      const known = registry.list().some((record) => record.meta.name === name);
      if (known) {
        if (!allowRun) throw new ScriptError('disabled', 'Script execution is disabled.');
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

    switch (name) {
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
        if (!allowRun) throw new ScriptError('disabled', 'Script execution is disabled.');
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
          ...(Array.isArray(call.args['params']) ? { params: call.args['params'] as never } : {}),
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
  } catch (error) {
    return finish({
      name: call.name,
      args: call.args,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export { asRecord };

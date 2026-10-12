/**
 * The script header contract.
 *
 * Every script starts with a header block that doubles as (a) a docstring in
 * the target language and (b) a machine-readable prompt for an AI agent:
 *
 *   @infagent-script v1
 *   @name hello
 *   @language js
 *   @description Say hello to someone.
 *   @callback run({ name }) -> { ok, result }
 *   @usage node scripts/hello.js '{"name":"World"}'
 *   @params [{"name":"name","type":"string","required":false}]
 *   @agent
 *     Use this script when the user greets someone.
 *     Call it with {"name": "<person>"} and read result.message.
 */
import process from 'node:process';

import type { ScriptLanguage, ScriptMeta, ScriptParam } from './types.js';

export const HEADER_VERSION = 'infagent-script/v1';

const JS_OPEN = '/**';
const JS_CLOSE = ' */';
const PY_OPEN = '"""';
const PY_CLOSE = '"""';

const ORDERED_KEYS = [
  'version',
  'name',
  'language',
  'description',
  'callback',
  'usage',
  'params',
] as const;

function pad(line: string): string {
  return ` * ${line}`.trimEnd();
}

/**
 * Header lines live inside a block comment or a docstring, so any comment
 * terminator appearing inside the text — for example a slash-star sequence
 * written in a user-supplied prompt — must be neutralised, otherwise the
 * generated file stops parsing and every call to it fails.
 */
function sanitize(value: string, language: ScriptLanguage): string {
  const joined = value.replace(/\r\n/g, '\n');
  return language === 'js'
    ? joined.replace(/\*\//g, '*\\/')
    : joined.replace(/"""/g, "'''").replace(/\\\s*$/gm, '\\\\');
}

/** `@infagent-script v1` — the marker line carries only the bare version. */
function markerVersion(version: string): string {
  const stripped = version.replace(/^infagent-script\//, '').trim();
  return stripped || 'v1';
}

/** Render a header block for the given language. */
export function buildHeader(meta: ScriptMeta, options: { js?: boolean } = {}): string {
  const useJs = options.js ?? meta.language === 'js';
  const lines: string[] = [
    `@infagent-script ${markerVersion(meta.version || HEADER_VERSION)}`,
    `@name ${meta.name}`,
    `@language ${meta.language}`,
    `@description ${sanitize(meta.description, meta.language)}`,
    `@callback ${sanitize(meta.callback, meta.language)}`,
    `@usage ${meta.usage}`,
    `@params ${JSON.stringify(meta.params)}`,
    '@agent',
    ...indentBlock(sanitize(meta.agentPrompt, meta.language)),
  ];

  if (useJs) {
    return [JS_OPEN, ...lines.map(pad), JS_CLOSE].join('\n');
  }
  return [PY_OPEN, ...lines, PY_CLOSE].join('\n');
}

function indentBlock(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `  ${line}`.trimEnd());
}

function normalizeLanguage(value: string | undefined, fallback: ScriptLanguage): ScriptLanguage {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'js' || raw === 'javascript' || raw === 'node' || raw === 'mjs') return 'js';
  if (raw === 'py' || raw === 'python' || raw === 'python3') return 'py';
  return fallback;
}

function parseParams(raw: string | undefined): ScriptParam[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        name: String(item['name'] ?? 'arg'),
        type: (item['type'] as ScriptParam['type']) ?? 'any',
        ...(item['required'] === undefined ? {} : { required: Boolean(item['required']) }),
        ...(item['description'] === undefined ? {} : { description: String(item['description']) }),
        ...(item['default'] === undefined ? {} : { default: item['default'] }),
      }));
  } catch {
    return [];
  }
}

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
export function parseHeader(source: string, language: ScriptLanguage, name: string): ParsedHeader {
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  const start = lines.findIndex((line) => /(\/\*\*|""")/.test(line) && line.trim().length <= 4);
  const values = new Map<string, string>();
  const agentLines: string[] = [];
  let found = false;
  let inAgent = false;
  let end = start;

  if (start !== -1) {
    const isJs = lines[start]?.includes('/**') ?? false;
    const closer = isJs ? JS_CLOSE : PY_CLOSE;
    for (let index = start + 1; index < lines.length; index += 1) {
      const raw = lines[index] ?? '';
      if (raw.trim().startsWith(closer) || raw.trim().endsWith(closer)) {
        end = index;
        break;
      }
      const text = raw.replace(/^\s*(\*|\/\/)?\s?/, '').trimEnd();
      const marker = /^@([a-z-]+)\s?(.*)$/.exec(text);
      if (marker) {
        const key = marker[1] ?? '';
        const value = (marker[2] ?? '').trim();
        if (key === 'infagent-script') {
          found = true;
          values.set(
            'version',
            value ? `infagent-script/${value.replace(/^infagent-script\//, '')}` : HEADER_VERSION,
          );
        } else if (key === 'agent') {
          inAgent = true;
        } else {
          inAgent = false;
          values.set(key, value);
        }
        continue;
      }
      if (inAgent) agentLines.push(text);
    }
    if (end === start) end = start;
  }

  const meta: ScriptMeta = {
    version: values.get('version') ?? HEADER_VERSION,
    name: values.get('name') ?? name,
    language: normalizeLanguage(values.get('language'), language),
    description: values.get('description') ?? '',
    callback: values.get('callback') ?? `run(args) -> { ok, result }`,
    usage: values.get('usage') ?? defaultUsage(name, language),
    params: parseParams(values.get('params')),
    agentPrompt: agentLines.join('\n').trim(),
  };

  return { meta, found, bodyStart: end + 1 };
}

/** What the usage line should tell a reader to type: Windows has no `python3`. */
const PYTHON_LABEL = process.platform === 'win32' ? 'python' : 'python3';

export function defaultUsage(name: string, language: ScriptLanguage): string {
  const payload = '\'{"example":true}\'';
  return language === 'js'
    ? `node scripts/${name}.js ${payload}`
    : `${PYTHON_LABEL} scripts/${name}.py ${payload}`;
}

export function defaultAgentPrompt(
  name: string,
  description: string,
  params: ScriptParam[],
): string {
  const args = params
    .map((param) => `"${param.name}": <${param.type}${param.required ? ', required' : ''}>`)
    .join(', ');
  const when = (description || 'the task matches the script description')
    .trim()
    .replace(/\.+$/, '');
  return [
    `Use this script when: ${when}.`,
    `Call it with JSON arguments: { ${args || '/* no parameters */'} }.`,
    'It prints a single JSON envelope on stdout: { "ok": true, "result": ... }.',
    `On failure it prints { "ok": false, "error": "..." } and exits non-zero — check the envelope before retrying.`,
    `Never guess a different name: the script is registered as "${name}".`,
  ].join('\n');
}

/** Body template for a new script: exports `run()` and prints the JSON envelope. */
export function defaultBody(name: string, language: ScriptLanguage, description: string): string {
  if (language === 'js') {
    return [
      "import { pathToFileURL } from 'node:url';",
      '',
      '/**',
      ` * ${description || `${name} — agent script`}`,
      ' */',
      'export function run(args = {}) {',
      '  // TODO: implement the script logic here.',
      '  return { echo: args };',
      '}',
      '',
      'const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;',
      '',
      'if (isMain) {',
      '  let payload = {};',
      '  try {',
      '    payload = process.argv[2] ? JSON.parse(process.argv[2]) : {};',
      '    process.stdout.write(`${JSON.stringify({ ok: true, result: run(payload) })}\\n`);',
      '  } catch (error) {',
      '    const message = error instanceof Error ? error.message : String(error);',
      '    process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\\n`);',
      '    process.exitCode = 1;',
      '  }',
      '}',
      '',
    ].join('\n');
  }

  return [
    'import json',
    'import sys',
    '',
    '',
    'def run(args):',
    `    """${description || `${name} — agent script`}"""`,
    '    # TODO: implement the script logic here.',
    '    return {"echo": args}',
    '',
    '',
    'if __name__ == "__main__":',
    '    try:',
    '        payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}',
    '        print(json.dumps({"ok": True, "result": run(payload)}, ensure_ascii=False))',
    '    except Exception as error:  # noqa: BLE001',
    '        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))',
    '        sys.exit(1)',
    '',
  ].join('\n');
}

/** Compose a complete script file from metadata. */
export function composeScript(meta: ScriptMeta, body?: string): string {
  const header = buildHeader(meta);
  const content = body ?? defaultBody(meta.name, meta.language, meta.description);
  return `${header}\n\n${content.replace(/^\n+/, '')}`;
}

export { ORDERED_KEYS };

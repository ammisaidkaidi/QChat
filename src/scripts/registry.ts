/**
 * Script registry — the built-in toolbox an AI agent calls.
 *
 * The `scripts/` folder is the single source of truth: every `.js` / `.py` file
 * there is parsed for its `@infagent-script` header, which supplies the
 * description, callback signature and the prompt telling an agent when to use
 * it. Nothing is indexed in a side file, so the folder stays portable.
 *
 * Built-in callbacks: createScript, removeScript, listScripts, readScript,
 * updateScript, searchScripts, runScript, describeScript, scriptStats.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

import { composeScript, defaultAgentPrompt, defaultUsage, parseHeader } from './header.js';
import { runScriptFile } from './runner.js';
import { SCRIPT_LANGUAGES } from './types.js';
import type {
  CreateScriptInput,
  ScriptDetail,
  ScriptLanguage,
  ScriptMeta,
  ScriptRecord,
  ScriptRunResult,
  ScriptStats,
  ToolDefinition,
  UpdateScriptInput,
} from './types.js';

export const SCRIPT_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export class ScriptError extends Error {
  public readonly code: 'invalid_name' | 'not_found' | 'exists' | 'io' | 'disabled';

  constructor(code: ScriptError['code'], message: string) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

export interface ScriptRegistryOptions {
  /** Folder holding agent scripts. Defaults to `$INFAGENT_SCRIPTS_DIR` or `<cwd>/scripts`. */
  root?: string;
  /** Execution timeout, ms. Defaults to `$INFAGENT_SCRIPT_TIMEOUT_MS` or 30000. */
  timeoutMs?: number;
  /** Allow `runScript()`. Defaults to `$INFAGENT_ALLOW_RUN !== '0'`. */
  allowRun?: boolean;
}

function languageOf(file: string): ScriptLanguage | undefined {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return (SCRIPT_LANGUAGES as readonly string[]).includes(ext)
    ? (ext as ScriptLanguage)
    : undefined;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class ScriptRegistry {
  public readonly root: string;
  private readonly timeoutMs: number;
  private readonly allowRun: boolean;

  constructor(options: ScriptRegistryOptions = {}) {
    const envRoot = process.env['INFAGENT_SCRIPTS_DIR'];
    this.root = resolve(options.root ?? envRoot ?? join(process.cwd(), 'scripts'));
    this.timeoutMs =
      options.timeoutMs ?? Number(process.env['INFAGENT_SCRIPT_TIMEOUT_MS'] ?? 30_000);
    this.allowRun = options.allowRun ?? process.env['INFAGENT_ALLOW_RUN'] !== '0';
  }

  /**
   * Create the folder on first use so a fresh checkout just works, and drop an
   * ESM marker so agent-authored `.js` scripts (`export function run`, top-level
   * `import.meta.url`) execute as ES modules even when the folder is copied
   * outside this package.
   */
  public ensureRoot(): string {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    const marker = join(this.root, 'package.json');
    if (!existsSync(marker)) {
      writeFileSync(
        marker,
        `${JSON.stringify({ type: 'module', private: true }, null, 2)}\n`,
        'utf8',
      );
    }
    return this.root;
  }

  private assertName(name: string): void {
    if (!SCRIPT_NAME_PATTERN.test(name)) {
      throw new ScriptError(
        'invalid_name',
        `Invalid script name "${name}": use lowercase letters, digits, dot, dash or underscore (max 64 chars).`,
      );
    }
  }

  private fileForName(name: string): { file: string; language: ScriptLanguage } {
    this.assertName(name);
    for (const language of SCRIPT_LANGUAGES) {
      const file = join(this.root, `${name}.${language}`);
      if (existsSync(file)) return { file, language };
    }
    throw new ScriptError(
      'not_found',
      `No script named "${name}" in ${this.root} (looked for ${name}.js, ${name}.py).`,
    );
  }

  private toRecord(file: string, language: ScriptLanguage): ScriptRecord {
    const source = readFileSync(file, 'utf8');
    const name = basename(file).slice(0, -(language.length + 1));
    const { meta } = parseHeader(source, language, name);
    const stats = statSync(file);
    return {
      meta,
      file,
      relativePath: relative(process.cwd(), file).split('\\').join('/'),
      bytes: stats.size,
      modifiedAt: new Date(stats.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  /** `listScripts()` — every managed script, sorted by name. */
  public list(): ScriptRecord[] {
    this.ensureRoot();
    return readdirSync(this.root)
      .map((entry) => ({ entry, language: languageOf(entry) }))
      .filter(
        (item): item is { entry: string; language: ScriptLanguage } => item.language !== undefined,
      )
      .map((item) => this.toRecord(join(this.root, item.entry), item.language))
      .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  }

  /** `readScript(name)` — metadata plus the full source. */
  public read(name: string): ScriptDetail {
    const { file, language } = this.fileForName(name);
    const record = this.toRecord(file, language);
    return { ...record, source: readFileSync(file, 'utf8') };
  }

  /** `describeScript(name)` — the parsed header only. */
  public describe(name: string): ScriptMeta {
    return this.read(name).meta;
  }

  /** `createScript({...})` — write a new script with a generated header. */
  public create(input: CreateScriptInput): ScriptDetail {
    this.ensureRoot();
    this.assertName(input.name);

    const file = join(this.root, `${input.name}.${input.language}`);
    if (existsSync(file) && !input.overwrite) {
      throw new ScriptError(
        'exists',
        `Script "${input.name}" already exists at ${file}. Pass overwrite: true to replace it.`,
      );
    }

    const params = input.params ?? [];
    const meta: ScriptMeta = {
      version: 'infagent-script/v1',
      name: input.name,
      language: input.language,
      description: input.description,
      callback: input.callback ?? 'run(args) -> { ok, result }',
      usage: input.usage ?? defaultUsage(input.name, input.language),
      params,
      agentPrompt: input.agentPrompt ?? defaultAgentPrompt(input.name, input.description, params),
    };

    writeFileSync(file, composeScript(meta, input.body), 'utf8');
    return this.read(input.name);
  }

  /** `updateScript(name, patch)` — rewrite header and/or body in place. */
  public update(name: string, patch: UpdateScriptInput): ScriptDetail {
    const current = this.read(name);
    const meta: ScriptMeta = {
      ...current.meta,
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.params === undefined ? {} : { params: patch.params }),
      ...(patch.callback === undefined ? {} : { callback: patch.callback }),
      ...(patch.usage === undefined ? {} : { usage: patch.usage }),
      ...(patch.agentPrompt === undefined ? {} : { agentPrompt: patch.agentPrompt }),
    };

    const body =
      patch.body ??
      current.source.split('\n').slice(this.bodyStartLine(current.source, current.meta)).join('\n');
    writeFileSync(current.file, composeScript(meta, body.replace(/^\n+/, '')), 'utf8');
    return this.read(name);
  }

  private bodyStartLine(source: string, meta: ScriptMeta): number {
    return parseHeader(source, meta.language, meta.name).bodyStart + 2;
  }

  /** `removeScript(name)` — delete the file; returns what was removed. */
  public remove(name: string): {
    name: string;
    file: string;
    relativePath: string;
    language: ScriptLanguage;
  } {
    const { file, language } = this.fileForName(name);
    rmSync(file);
    return {
      name,
      file,
      relativePath: relative(process.cwd(), file).split('\\').join('/'),
      language,
    };
  }

  /** `searchScripts(query)` — match name, description or agent prompt. */
  public search(query: string): ScriptRecord[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.list();
    return this.list().filter((record) => {
      const haystack = [
        record.meta.name,
        record.meta.description,
        record.meta.agentPrompt,
        record.meta.callback,
      ]
        .join('\n')
        .toLowerCase();
      return needle.split(/\s+/).every((token) => haystack.includes(token));
    });
  }

  /** `runScript(name, args)` — execute with JSON args, return the envelope. */
  public async run(name: string, args: Record<string, unknown> = {}): Promise<ScriptRunResult> {
    if (!this.allowRun) {
      throw new ScriptError('disabled', 'Script execution is disabled (INFAGENT_ALLOW_RUN=0).');
    }
    const { file, language } = this.fileForName(name);
    return await runScriptFile(file, language, name, args, {
      timeoutMs: this.timeoutMs,
      cwd: process.cwd(),
    });
  }

  /** `scriptStats()` — counters for dashboards. */
  public stats(): ScriptStats {
    const records = this.list();
    const byLanguage: Record<ScriptLanguage, number> = { js: 0, py: 0 };
    let totalBytes = 0;
    for (const record of records) {
      byLanguage[record.meta.language] += 1;
      totalBytes += record.bytes;
    }
    return { count: records.length, byLanguage, totalBytes, root: this.root };
  }

  /** The ready-to-paste prompt telling an agent how to call this script. */
  public agentPrompt(name: string): string {
    const record = this.read(name);
    const { meta } = record;
    const required = meta.params.filter((param) => param.required).map((param) => param.name);
    return [
      `# Script "${meta.name}" (${meta.language})`,
      '',
      meta.description || '(no description)',
      '',
      '## When to use it',
      meta.agentPrompt || '- Always safe to call when the task matches the description.',
      '',
      '## How to call it',
      `- Tool call:  runScript({ "name": "${meta.name}", "args": { ... } })`,
      `- Shell:      ${meta.usage}`,
      `- HTTP:       POST /api/scripts/${meta.name}/run   body: { "args": { ... } }`,
      '',
      '## Arguments',
      meta.params.length === 0
        ? '- none'
        : meta.params
            .map(
              (param) =>
                `- ${param.name}: ${param.type}${param.required ? ' (required)' : ' (optional)'}${
                  param.description ? ` — ${param.description}` : ''
                }`,
            )
            .join('\n'),
      '',
      '## Contract',
      `- Callback: ${meta.callback}`,
      '- Success: stdout is a single JSON line `{"ok":true,"result":…}` and the exit code is 0.',
      '- Failure: `{"ok":false,"error":"…"}` with a non-zero exit code — inspect `error` before retrying.',
      required.length > 0
        ? `- These arguments are mandatory: ${required.join(', ')}.`
        : '- All arguments are optional.',
      `- File: ${record.relativePath}`,
    ].join('\n');
  }

  /** JSON-schema tool definitions an LLM can be handed directly. */
  public toolDefinitions(): ToolDefinition[] {
    const str = (description: string): { type: string; description: string } => ({
      type: 'string',
      description,
    });
    return [
      {
        name: 'listScripts',
        description:
          'List every agent script available in the scripts folder, with its description and language.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'searchScripts',
        description:
          'Find scripts whose name, description or usage prompt matches a free-text query.',
        parameters: {
          type: 'object',
          properties: { query: str('Words to match, e.g. "disk report".') },
          required: ['query'],
        },
      },
      {
        name: 'readScript',
        description: 'Read one script: parsed header metadata plus the full source code.',
        parameters: {
          type: 'object',
          properties: { name: str('Script name without extension, e.g. "hello".') },
          required: ['name'],
        },
      },
      {
        name: 'describeScript',
        description: 'Read only the header metadata of a script (cheaper than readScript).',
        parameters: {
          type: 'object',
          properties: { name: str('Script name without extension.') },
          required: ['name'],
        },
      },
      {
        name: 'createScript',
        description:
          'Create a new .js or .py agent script. The header (description, callback, usage, agent prompt) is generated automatically.',
        parameters: {
          type: 'object',
          properties: {
            name: str('Lowercase slug; becomes the file name.'),
            language: { type: 'string', description: 'Target language.', enum: SCRIPT_LANGUAGES },
            description: str('One line explaining what the script does.'),
            params: {
              type: 'array',
              description: 'Argument descriptors: [{ name, type, required, description }].',
            },
            agentPrompt: str('Optional custom prompt telling the agent when to call it.'),
            body: str('Optional source body; a working template is used when omitted.'),
            overwrite: {
              type: 'boolean',
              description: 'Replace an existing script of the same name.',
              default: false,
            },
          },
          required: ['name', 'language', 'description'],
        },
      },
      {
        name: 'updateScript',
        description: 'Patch an existing script: header fields and/or the whole body.',
        parameters: {
          type: 'object',
          properties: {
            name: str('Script to update.'),
            description: str('New description.'),
            body: str('New full body source.'),
            agentPrompt: str('New agent prompt.'),
          },
          required: ['name'],
        },
      },
      {
        name: 'removeScript',
        description:
          'Delete a script permanently. Ask the user for confirmation before calling this.',
        parameters: {
          type: 'object',
          properties: { name: str('Script to delete.') },
          required: ['name'],
        },
      },
      {
        name: 'runScript',
        description:
          'Execute a script with JSON arguments and return its stdout/stderr, exit code and parsed response envelope.',
        parameters: {
          type: 'object',
          properties: {
            name: str('Script to run.'),
            args: { type: 'object', description: 'JSON arguments passed to the script callback.' },
          },
          required: ['name'],
        },
      },
      {
        name: 'scriptStats',
        description: 'Counts of scripts by language, total size, and the managed folder.',
        parameters: { type: 'object', properties: {} },
      },
    ];
  }

  /** System prompt describing the whole toolbox, for pasting into an LLM. */
  public systemPrompt(): string {
    const records = this.list();
    return [
      '# InfAgent script toolbox',
      '',
      `You can call ${records.length} agent script(s) stored in \`${relative(process.cwd(), this.root) || this.root}\`.`,
      'Every script reads one JSON argument object and prints one JSON envelope on stdout.',
      '',
      '## Protocol',
      '1. `searchScripts` or `listScripts` to discover what exists.',
      '2. `readScript` before calling a script for the first time.',
      '3. `runScript({ name, args })` to execute; parse `{"ok":true,"result":…}`.',
      '4. On `{"ok":false,"error":…}` fix the arguments or report the error — never invent a result.',
      '5. `createScript` when no script fits; `updateScript` to fix one; `removeScript` only with explicit user consent.',
      '',
      '## Available scripts',
      records.length === 0
        ? '- (none yet — create the first one with createScript)'
        : records
            .map(
              (record) =>
                `- **${record.meta.name}** (${record.meta.language}) — ${record.meta.description || 'no description'} · args: ${
                  record.meta.params.map((param) => param.name).join(', ') || 'none'
                }`,
            )
            .join('\n'),
    ].join('\n');
  }

  /** Human-readable table used by the CLI. */
  public format(): string {
    const records = this.list();
    if (records.length === 0)
      return `No scripts yet in ${this.root}. Create one with: infagent scripts create <name> --lang js --desc "…"`;
    const width = Math.max(...records.map((record) => record.meta.name.length));
    return records
      .map(
        (record) =>
          `${record.meta.name.padEnd(width)}  ${record.meta.language.padEnd(2)}  ${record.meta.description || '(no description)'}  →  ${record.relativePath}`,
      )
      .join('\n');
  }
}

/** Default registry bound to `<cwd>/scripts`, used by the free functions below. */
export const defaultRegistry = new ScriptRegistry();

export const listScripts = (): ScriptRecord[] => defaultRegistry.list();
export const readScript = (name: string): ScriptDetail => defaultRegistry.read(name);
export const describeScript = (name: string): ScriptMeta => defaultRegistry.describe(name);
export const createScript = (input: CreateScriptInput): ScriptDetail =>
  defaultRegistry.create(input);
export const updateScript = (name: string, patch: UpdateScriptInput): ScriptDetail =>
  defaultRegistry.update(name, patch);
export const removeScript = (name: string): ReturnType<ScriptRegistry['remove']> =>
  defaultRegistry.remove(name);
export const searchScripts = (query: string): ScriptRecord[] => defaultRegistry.search(query);
export const runScript = (
  name: string,
  args: Record<string, unknown> = {},
): Promise<ScriptRunResult> => defaultRegistry.run(name, args);
export const scriptStats = (): ScriptStats => defaultRegistry.stats();
export const scriptAgentPrompt = (name: string): string => defaultRegistry.agentPrompt(name);
export const scriptTools = (): ToolDefinition[] => defaultRegistry.toolDefinitions();
export const scriptSystemPrompt = (): string => defaultRegistry.systemPrompt();

export { nowIso };

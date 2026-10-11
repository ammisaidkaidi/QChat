/**
 * Types for the agent script toolbox.
 *
 * A "script" is a self-describing .js / .py file that an AI agent may call.
 * Every script carries a machine-readable header (see `header.ts`) that tells
 * the agent when to use it, how to call it, and what it returns.
 */
export const SCRIPT_LANGUAGES = ['js', 'py'] as const;

export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

export type ScriptParamType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

export interface ScriptParam {
  name: string;
  type: ScriptParamType;
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface ScriptMeta {
  /** Header contract version, currently `infagent-script/v1`. */
  version: string;
  /** Unique slug, matches the file name (`hello.js` → `hello`). */
  name: string;
  language: ScriptLanguage;
  description: string;
  /** Callback signature, e.g. `run({ name }) -> { ok, result }`. */
  callback: string;
  /** How to invoke it from a shell. */
  usage: string;
  params: ScriptParam[];
  /** Free-form instruction block telling an agent when/how to call the script. */
  agentPrompt: string;
}

export interface ScriptRecord {
  meta: ScriptMeta;
  /** Absolute path on disk. */
  file: string;
  /** Path relative to the repository root, e.g. `scripts/hello.js`. */
  relativePath: string;
  bytes: number;
  modifiedAt: string;
}

export interface ScriptDetail extends ScriptRecord {
  /** Full file contents, header included. */
  source: string;
}

export interface ScriptRunResult {
  ok: boolean;
  name: string;
  language: ScriptLanguage;
  /** Human-readable command that was executed. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  /** stdout parsed as the `{ ok, result }` envelope emitted by the template. */
  envelope: unknown;
}

export interface CreateScriptInput {
  name: string;
  language: ScriptLanguage;
  description: string;
  params?: ScriptParam[];
  callback?: string;
  usage?: string;
  agentPrompt?: string;
  /** Body source. Defaults to the per-language template. */
  body?: string;
  /** Replace an existing script instead of failing. */
  overwrite?: boolean;
}

export interface UpdateScriptInput {
  description?: string;
  params?: ScriptParam[];
  callback?: string;
  usage?: string;
  agentPrompt?: string;
  body?: string;
}

export interface ScriptStats {
  count: number;
  byLanguage: Record<ScriptLanguage, number>;
  totalBytes: number;
  root: string;
}

export interface ToolProperty {
  type: string;
  description?: string;
  enum?: readonly string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolProperty>;
    required?: string[];
  };
}

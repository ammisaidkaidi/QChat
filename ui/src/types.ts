/** Mirrors `src/scripts/types.ts` (the browser bundle stays self-contained). */
export type ScriptLanguage = 'js' | 'py';

export type ScriptParamType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';

export interface ScriptParam {
  name: string;
  type: ScriptParamType;
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface ScriptMeta {
  version: string;
  name: string;
  language: ScriptLanguage;
  description: string;
  callback: string;
  usage: string;
  params: ScriptParam[];
  agentPrompt: string;
}

export interface ScriptRecord {
  meta: ScriptMeta;
  file: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
}

export interface ScriptDetail extends ScriptRecord {
  source: string;
}

export interface ScriptStats {
  count: number;
  byLanguage: Record<ScriptLanguage, number>;
  totalBytes: number;
  root: string;
}

export interface ScriptRunResult {
  ok: boolean;
  name: string;
  language: ScriptLanguage;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  envelope: unknown;
}

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  node: string;
  scriptsDir: string;
  allowRun: boolean;
  stats: ScriptStats;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: readonly string[] }>;
    required?: string[];
  };
}

export interface CreateScriptInput {
  name: string;
  language: ScriptLanguage;
  description: string;
  params?: ScriptParam[];
  agentPrompt?: string;
  body?: string;
  overwrite?: boolean;
}

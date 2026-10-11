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

/* ── chat ─────────────────────────────────────────────────────────────────── */

export type EngineState =
  | 'unavailable'
  | 'absent'
  | 'downloading'
  /** Model file present but not loaded into memory yet. */
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface EngineStatus {
  state: EngineState;
  modelPath: string;
  modelPresent: boolean;
  modelBytes: number;
  modelUrl: string;
  downloadProgress: number;
  downloadedBytes: number;
  downloadTotalBytes: number;
  contextSize: number;
  threads: number;
  modelName: string;
  quantization: string;
  toolsAvailable: boolean;
  ramUsedMb: number;
  lastError: string | null;
}

export interface ChatConfig {
  scriptCount: number;
  modelsDir: string;
  contextSize: number;
  threads: number;
  defaultTemperature: number;
  defaultMaxTokens: number;
  thinking: boolean;
  tools: boolean;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A rendered assistant turn: text, reasoning, tool activity and timing. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  thinking: string;
  calls: ChatToolCall[];
  stats?: { totalTokens: number; tokensPerSecond: number; durationMs: number };
  error?: string;
  streaming?: boolean;
}

export type ChatEvent =
  | { type: 'status'; state: EngineState; detail?: string }
  | { type: 'thinking'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'tool_result'; call: ChatToolCall }
  | { type: 'stats'; totalTokens: number; tokensPerSecond: number; durationMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string };

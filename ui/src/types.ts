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
  /** Identifier from the model's settings file. */
  modelId: string;
  modelPath: string;
  modelPresent: boolean;
  modelBytes: number;
  modelUrl: string;
  downloadProgress: number;
  downloadedBytes: number;
  downloadTotalBytes: number;
  /** Folder holding the settings files (project `models/`). */
  modelsDir: string;
  /** Folder holding the weights (outside the repository). */
  weightsDir: string;
  /** Settings file describing the active model. */
  settingsFile: string;
  contextSize: number;
  threads: number;
  modelName: string;
  quantization: string;
  description: string;
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
  /** The plan lines of a multi-step turn, in order. */
  plans?: { text: string; step?: number }[];
  /** Skills a user turn pinned with `/name` — loaded for that message. */
  skills?: string[];
  stats?: {
    totalTokens: number;
    tokensPerSecond: number;
    durationMs: number;
    repairs?: number;
  };
  error?: string;
  streaming?: boolean;
}

/** Settings stored with one chat rather than shared by every conversation. */
export interface ChatSettings {
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  tools: boolean;
  net: boolean;
  systemPrompt: string;
  maxSteps: number;
  /** null = every enabled MCP server; [] = none. */
  mcpServers: string[] | null;
  modelSource: 'local' | 'cloud';
  providerId: string;
  modelId: string;
  /** Name of a shared prompt template; the selection is per chat. */
  styleName: string;
}

/** Settings sent to the server to build the next-turn system prompt preview. */
export interface ChatPromptPreviewRequest {
  modelSource: 'local' | 'cloud';
  providerId: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  tools: boolean;
  net: boolean;
  systemPrompt: string;
  maxToolIterations: number;
  promptTemplate: string;
  skills: string[];
  mcpServers?: string[];
}

/** Current generated prompt plus the chat configuration shown beside it. */
export interface RuntimePromptPreview {
  status: 'loading' | 'ready' | 'error';
  prompt: string;
  error: string | null;
  modelSource: 'local' | 'cloud';
  modelId: string;
  modelLabel: string;
  modelStyle: string;
  styleName: string;
  toolsEnabled: boolean;
  webEnabled: boolean;
  mcpServers: string[];
  skills: string[];
  hasCustomPrompt: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  turnCount: number;
  modelSource: 'local' | 'cloud';
  providerId: string;
  modelId: string;
}

export interface StoredChat extends ChatSummary {
  settings: ChatSettings;
  turns: ChatTurn[];
}

/** One entry of the `models/` catalogue, as served by `GET /api/models`. */
export interface ModelRecord {
  settings: {
    version: string;
    id: string;
    name: string;
    file: string;
    family?: string;
    quantization?: string;
    description?: string;
    source?: { url?: string; repo?: string };
    sizeBytes?: number;
    contextSize?: number;
    threads?: number;
    temperature?: number;
    maxTokens?: number;
    thinking?: boolean;
    chatWrapper?: 'chatml' | 'qwen' | 'auto';
    style?: 'qwen3' | 'xlam' | 'plain';
    agentPrompt?: string;
  };
  path: string;
  settingsPath: string;
  weightsDir: string;
  present: boolean;
  sizeBytes: number;
  bytesOnDisk: number;
  active: boolean;
}

export interface ModelCatalog {
  dir: string;
  weightsDir: string;
  /** Engine's current in-process model. */
  active: string;
  /** Global default model used only to seed a brand-new chat. */
  defaultActive?: string;
  models: ModelRecord[];
}

export type CloudAdapter = 'openai-compatible' | 'anthropic' | 'gemini';

export interface CloudModel {
  id: string;
  name: string;
}

export interface CloudProvider {
  id: string;
  name: string;
  adapter: CloudAdapter;
  baseUrl: string;
  models: CloudModel[];
  updatedAt: string;
  /** Only a boolean leaves the server; the secret is never sent back. */
  keyConfigured: boolean;
}

export interface CloudProviderPreset {
  id: string;
  name: string;
  adapter: CloudAdapter;
  baseUrl: string;
}

/** One skill in `skills/`. */
export interface SkillRecord {
  meta: { version: string; name: string; description: string; when: string; updatedAt: string };
  file: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
}

export interface SkillDetailFull extends SkillRecord {
  body: string;
  source: string;
}

/** A web search result. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchReport {
  provider: string;
  query: string;
  results: SearchResult[];
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** MCP server state as reported by `/api/mcp`. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  state: 'stopped' | 'starting' | 'ready' | 'error';
  description: string;
  command: string;
  args: string[];
  enabled: boolean;
  tools: McpTool[];
  serverInfo: { name?: string; version?: string };
  lastError: string | null;
  stderr: string[];
}

export interface McpCatalogue {
  configPath: string;
  servers: McpServerStatus[];
  tools: { server: string; name: string; qualified: string; description: string }[];
}

export type AlertLevel = 'info' | 'success' | 'warning' | 'error';

/** One user-facing alert, raised by the model, the CLI or the API. */
export interface AlertRecord {
  id: string;
  title: string;
  message: string;
  level: AlertLevel;
  source: string;
  at: string;
}

export type ChatEvent =
  | { type: 'status'; state: EngineState; detail?: string }
  | { type: 'thinking'; text: string }
  | { type: 'token'; text: string }
  /** Discard the partially streamed reply (the engine is retrying this turn). */
  | { type: 'reset' }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'tool_result'; call: ChatToolCall }
  /** What the model says the current step is for (`plan` of a tool_call). */
  | { type: 'plan'; text: string; step?: number }
  /** A user-facing alert was raised (showAlert, the CLI or the API). */
  | { type: 'alert'; alert: AlertRecord }
  | {
      type: 'stats';
      totalTokens: number;
      tokensPerSecond: number;
      durationMs: number;
      repairs?: number;
    }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One variable in the Config tab (`GET /api/env`). */
export interface EnvEntry {
  key: string;
  /** Real value, unless the key holds a credential — then `null`. */
  value: string | null;
  /** What the value column shows (a mask for credentials). */
  masked: string;
  secret: boolean;
  /** False when the key is declared but has no value. */
  set: boolean;
  group: string;
  note: string;
}

export interface EnvSnapshot {
  path: string;
  reference: string;
  mask: string;
  exists: boolean;
  entries: EnvEntry[];
}

/**
 * Answer to an explicit reveal: the plaintext of one key, or of every
 * credential at once (`{ all: true }`). Only ever requested by a click in the
 * Config tab — a normal snapshot never carries these values.
 */
export interface EnvRevealResult {
  key: string;
  value: string;
  secret: boolean;
}

export interface EnvRevealAllResult {
  values: Record<string, string>;
}

export interface EnvSaveResult {
  path: string;
  changed: string[];
  removed: string[];
  backup: string | null;
  note: string;
  snapshot: Omit<EnvSnapshot, 'reference' | 'mask'>;
}

/** One "way of thinking" the user can select (`models/systemPrompts.json`). */
export interface SystemPromptTemplate {
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  builtin?: boolean;
  updatedAt?: string;
}

export interface PromptCatalogue {
  file: string;
  active: string;
  prompts: SystemPromptTemplate[];
}

/** One tool file under the toolbox root, as the Toolbox tab sees it. */
export interface ToolboxFileEntry {
  name: string;
  bytes: number;
  mtime: string;
  /** Tool names this file exports (empty when the server is not running). */
  tools: string[];
  /** True when the running server loaded it, false when it refused it, null when unknown. */
  loaded: boolean | null;
}

export interface ToolboxSnapshot {
  root: string;
  files: ToolboxFileEntry[];
  /** Refusals the server reported, one line each. */
  refused: string[];
  /** Every tool the model can call, without the `toolbox__` prefix. */
  tools: string[];
  server: { name: string; state: string; configured: boolean; enabled: boolean };
  limits: { maxBytes: number; maxFiles: number };
}

/** What a reload reported: what the tool list gained and lost. */
export interface ToolboxReload {
  ok: boolean;
  text: string;
  added: string[];
  removed: string[];
  refused: string[];
}

export interface ToolboxSaveResult {
  file: { name: string; bytes: number; mtime: string };
  reload: ToolboxReload;
}

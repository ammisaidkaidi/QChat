/**
 * Local inference engine — Qwen3-0.6B on CPU via llama.cpp (node-llama-cpp).
 *
 * Design notes
 *  - `node-llama-cpp` is imported lazily, so the rest of InfAgent keeps working
 *    when the native dependency is missing (fresh checkout before `npm install`).
 *  - ChatML is used as the chat wrapper instead of the GGUF's Jinja template:
 *    with Qwen3 GGUFs that template emits an immediate stop token on llama.cpp,
 *    which yields empty replies.
 *  - One generation runs at a time (a single context sequence); a concurrent
 *    request gets a `busy` error rather than silently queueing.
 *  - The model is unloaded after an idle period so a small box stays healthy.
 */
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';

import type {
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaContextSequence,
  LlamaGrammar,
  LlamaModel,
  Token,
} from 'node-llama-cpp';

import { netEnabled } from '../capabilities/search.js';
import type { McpManager } from '../mcp/manager.js';
import { AlertBus } from '../capabilities/alerts.js';
import type { Alert } from '../capabilities/alerts.js';
import { ScriptRegistry } from '../scripts/registry.js';
import { SkillRegistry } from '../skills/registry.js';
import { DEFAULT_MODELS_DIR, ModelStore } from './modelStore.js';
import type { ModelRecord, ModelSettings } from './modelStore.js';
import { SystemPromptStore } from './prompts.js';
import {
  type MergedFact,
  askedListing,
  buildSystemPrompt,
  finalAnswerPrompt,
  formatToolResult,
  guardToolAnswer,
  progressPrompt,
  readableResult,
  stripJsonBlobs,
  toolResultPrompt,
  toolboxNames,
  unusedRequestPaths,
} from './prompt.js';
import type { ToolOutcome } from './prompt.js';
import {
  MAX_REPAIRS,
  ProtocolStream,
  envelopeGrammarSchema,
  envelopeRepairPrompt,
  finalOnlyGrammarSchema,
  grammarEnabled,
  parseEnvelope,
  resolveProtocolMode,
  resultEnvelope,
  stepBudget,
} from './protocol.js';
import type { ParseResult, ProtocolMode } from './protocol.js';
import { OutputSplitter } from './splitter.js';
import { dispatchTool, extractToolCalls } from './tools.js';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  EngineState,
  EngineStatus,
} from './types.js';

/**
 * The model InfAgent ships with: its settings file is committed under `models/`
 * and the 380 MB of weights are fetched on first use into the weights cache.
 */
export const DEFAULT_MODEL: ModelSettings = {
  version: 'infagent-model/v1',
  id: 'Qwen3-0.6B-Q4_K_M',
  name: 'Qwen3 0.6B (Q4_K_M)',
  file: 'Qwen3-0.6B-Q4_K_M.gguf',
  family: 'qwen3',
  quantization: 'Q4_K_M',
  description: 'Small, fast, tool-calling capable local chat model. The default choice on CPU.',
  source: {
    repo: 'unsloth/Qwen3-0.6B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
  },
  contextSize: 2048,
  threads: 2,
  temperature: 0.4,
  maxTokens: 512,
  thinking: false,
  chatWrapper: 'chatml',
};

export { DEFAULT_MODELS_DIR, ModelStore };
export type { ModelCatalogue, ModelRecord, ModelSettings } from './modelStore.js';

/** One dispatched tool call, as the injected `tool_result` should show it. */
type Outcome = { name?: string; ok: boolean; result: unknown };

export class ChatError extends Error {
  public readonly code: 'busy' | 'unavailable' | 'not_ready' | 'download' | 'aborted';

  constructor(code: ChatError['code'], message: string) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
  }
}

export interface QwenEngineOptions {
  registry?: ScriptRegistry;
  /** Skill library offered to the model. */
  skills?: SkillRegistry;
  /** MCP servers whose tools are callable. */
  mcp?: McpManager;
  /** Alert display shared with the interface. */
  alerts?: AlertBus;
  /** Settings folder. Defaults to `INFAGENT_SETTINGS_DIR`, then `<project>/models`. */
  modelsDir?: string;
  /** Weights folder override; defaults to `INFAGENT_WEIGHTS_DIR`. */
  weightsDir?: string;
  /** Explicit weights that bypass the catalogue entirely. */
  modelPath?: string;
  /** System-prompt templates the user can pick from. Defaults to the models folder. */
  prompts?: SystemPromptStore;
  modelUrl?: string;
  contextSize?: number;
  threads?: number;
  idleUnloadMs?: number;
  allowRun?: boolean;
}

interface Loaded {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
  chatWrapper: unknown;
}

/**
 * Turns a push-based producer (the token callback) into an async stream, so the
 * browser receives tokens while the model is still generating instead of all at
 * once when the turn ends.
 */
export class EventChannel<T> {
  private items: T[] = [];
  private wakeups: (() => void)[] = [];

  public push(item: T): void {
    this.items.push(item);
    this.wakeups.shift()?.();
  }

  public async *drain(work: Promise<unknown>): AsyncGenerator<T> {
    let finished = false;
    const settle = (): void => {
      finished = true;
      this.wakeups.shift()?.();
    };
    void work.then(settle, settle);

    for (;;) {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (item !== undefined) yield item;
      }
      if (finished) return;

      await Promise.race([
        work.catch(() => undefined),
        new Promise<void>((resolveWake) => this.wakeups.push(resolveWake)),
      ]);

      if (finished) {
        while (this.items.length > 0) {
          const item = this.items.shift();
          if (item !== undefined) yield item;
        }
        return;
      }
    }
  }
}

export class QwenEngine {
  public readonly registry: ScriptRegistry;
  /** Skill library (`skills/*.md`). */
  public readonly skills: SkillRegistry;
  /** MCP servers, if any are configured. */
  public readonly mcp: McpManager | null;
  /** Where `showAlert` puts alerts and where the interface reads them from. */
  public readonly alerts: AlertBus;
  /** Catalogue over `models/`: which model is used, and how. */
  public readonly store: ModelStore;
  /** Selectable system-prompt templates ("way of thinking"). */
  public readonly prompts: SystemPromptStore;
  private readonly idleUnloadMs: number;
  private readonly allowRun: boolean;
  /** Explicit overrides; unset values follow the active model's settings. */
  private readonly contextOverride: number | null;
  private readonly threadsOverride: number | null;
  private readonly urlOverride: string | null;

  private loaded: Loaded | null = null;
  /**
   * Warm session cache: re-evaluating the whole conversation on every turn is
   * the dominant cost on a 2-core CPU, so a session is reused while the incoming
   * history still matches the one it was built from (KV cache stays valid).
   */
  private sessionCache: { fingerprint: string; session: LlamaChatSession } | null = null;
  private state: EngineState;
  private lastError: string | null = null;
  private busy = false;
  private loading: Promise<Loaded> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private downloadProgress = 0;
  private downloadedBytes = 0;
  private downloadTotalBytes = 0;
  private downloading: Promise<string> | null = null;

  constructor(options: QwenEngineOptions = {}) {
    this.registry = options.registry ?? new ScriptRegistry();
    this.skills = options.skills ?? new SkillRegistry();
    this.mcp = options.mcp ?? null;
    this.alerts = options.alerts ?? new AlertBus();
    this.store = new ModelStore({
      ...(options.modelsDir === undefined ? {} : { dir: options.modelsDir }),
      ...(options.weightsDir === undefined ? {} : { weightsDir: options.weightsDir }),
      ...(options.modelPath === undefined ? {} : { overridePath: options.modelPath }),
    });
    this.store.ensureDir();
    // Ship the bundled model's settings file on first run, so the folder is
    // self-describing even before the weights are fetched.
    if (this.store.list().length === 0) this.store.register(DEFAULT_MODEL);
    this.prompts = options.prompts ?? new SystemPromptStore({ catalogue: this.store });

    const env = (key: string): number | null => {
      const raw = process.env[key];
      if (raw === undefined) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    this.contextOverride = options.contextSize ?? env('INFAGENT_LLM_CONTEXT');
    this.threadsOverride = options.threads ?? env('INFAGENT_LLM_THREADS');
    this.urlOverride = options.modelUrl ?? process.env['INFAGENT_MODEL_URL'] ?? null;
    this.idleUnloadMs =
      options.idleUnloadMs ?? Number(process.env['INFAGENT_LLM_IDLE_UNLOAD_MS'] ?? 600_000);
    this.allowRun = options.allowRun ?? process.env['INFAGENT_ALLOW_RUN'] !== '0';
    this.state = this.activeModel().present ? 'idle' : 'absent';
  }

  /** Folder holding the model settings files. */
  public get modelsDir(): string {
    return this.store.dir;
  }

  /** Folder the weights live in (outside the repository by default). */
  public get weightsDir(): string {
    return this.store.weightsDir;
  }

  /** Weights of the active model. */
  public get modelPath(): string {
    return this.activeModel().path;
  }

  /** Where the active model is fetched from. */
  public get modelUrl(): string {
    return this.activeModel().url;
  }

  /** Context window actually used for the active model. */
  public get contextSize(): number {
    return this.contextOverride ?? this.store.activeContext().contextSize;
  }

  /** llama.cpp threads actually used for the active model. */
  public get threads(): number {
    return this.threadsOverride ?? this.store.activeContext().threads;
  }

  /** The active record plus the resolved download URL. */
  private activeModel(): ModelRecord & { url: string } {
    const record = this.store.active();
    const fallback = record?.settings.id === DEFAULT_MODEL.id ? DEFAULT_MODEL : null;
    const url = this.urlOverride ?? record?.settings.source?.url ?? fallback?.source?.url ?? '';
    if (record) return { ...record, url };

    const path = `${this.store.weightsDir}/${DEFAULT_MODEL.file}`;
    const present = existsSync(path);
    const size = present ? statSync(path).size : 0;
    return {
      settings: { ...DEFAULT_MODEL },
      path,
      settingsPath: `${this.store.dir}/${DEFAULT_MODEL.id}.settings.json`,
      weightsDir: this.store.weightsDir,
      present,
      sizeBytes: size,
      bytesOnDisk: size,
      active: true,
      url,
    };
  }

  public status(): EngineStatus {
    const model = this.activeModel();
    const present = model.present && existsSync(model.path);
    const settings = model.settings;
    return {
      state: this.state === 'idle' && this.loaded ? 'ready' : this.state,
      modelId: settings.id,
      modelPath: model.path,
      modelPresent: present,
      modelBytes: present ? statSync(model.path).size : 0,
      modelUrl: model.url,
      modelsDir: this.store.dir,
      weightsDir: model.weightsDir,
      settingsFile: model.settingsPath,
      downloadProgress: this.downloadProgress,
      downloadedBytes: this.downloadedBytes,
      downloadTotalBytes: this.downloadTotalBytes,
      contextSize: this.contextSize,
      threads: this.threads,
      modelName: settings.name,
      quantization: settings.quantization ?? '',
      description: settings.description ?? '',
      toolsAvailable: this.allowRun,
      ramUsedMb: Math.round(process.memoryUsage().rss / 1048576),
      lastError: this.lastError,
    };
  }

  /** Every model in the catalogue, with the active one flagged. */
  public models(): {
    dir: string;
    weightsDir: string;
    active: string;
    models: ModelRecord[];
  } {
    const models = this.store.list();
    return {
      dir: this.store.dir,
      weightsDir: this.store.weightsDir,
      active: models.find((model) => model.active)?.settings.id ?? '',
      models,
    };
  }

  /**
   * Switch the active model. The current one is dropped from memory first, so
   * the switch costs nothing but a lazy reload on the next message.
   */
  public async useModel(id: string): Promise<ModelRecord> {
    if (this.busy) throw new ChatError('busy', 'The model is generating — try again in a moment.');
    const record = this.store.setActive(id);
    await this.unload();
    this.state = record.present ? 'idle' : 'absent';
    this.lastError = null;
    return record;
  }

  /**
   * Forget the current conversation and start the next turn from the system
   * prompt alone. The model stays loaded; only the chat history goes.
   */
  public resetSession(): void {
    this.sessionCache = null;
  }

  public isLoaded(): boolean {
    return this.loaded !== null;
  }

  public isBusy(): boolean {
    return this.busy;
  }

  /**
   * Fetch a model's weights into the weights folder.
   *
   * Defaults to the active model; its settings file is kept in sync with what
   * actually landed on disk.
   */
  public async downloadModel(id?: string): Promise<string> {
    if (this.downloading) return await this.downloading;

    this.downloading = (async (): Promise<string> => {
      const requested = id ? this.store.get(id) : null;
      if (id && !requested) throw new ChatError('download', `Unknown model "${id}".`);
      const active = this.activeModel();
      const settings = requested?.settings ?? active.settings;
      const url = requested?.settings.source?.url ?? active.url;
      const targetPath = requested?.path ?? active.path;

      if (!url) {
        throw new ChatError('download', `No download source is defined for ${settings.name}.`);
      }

      this.state = 'downloading';
      this.lastError = null;
      this.downloadProgress = 0;
      this.downloadedBytes = 0;
      this.downloadTotalBytes = 0;

      try {
        const { createModelDownloader } = await import('node-llama-cpp');
        const downloader = await createModelDownloader({
          modelUrl: url,
          dirPath: this.store.weightsDir,
          fileName: basename(settings.file || targetPath),
          onProgress: ({ totalSize, downloadedSize }) => {
            this.downloadTotalBytes = totalSize;
            this.downloadedBytes = downloadedSize;
            this.downloadProgress = totalSize > 0 ? Math.min(1, downloadedSize / totalSize) : 0;
          },
        });

        const file = await downloader.download();
        this.downloadProgress = 1;
        // Keep the settings file truthful about what is now on disk.
        const landed = existsSync(file) ? statSync(file).size : 0;
        this.store.writeSettings({
          ...settings,
          file: basename(file),
          ...(landed > 0 ? { sizeBytes: landed } : {}),
        });
        this.state = 'idle';
        return file;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.state = existsSync(targetPath) ? 'idle' : 'error';
        throw new ChatError('download', `Model download failed: ${this.lastError}`);
      } finally {
        this.downloading = null;
      }
    })();

    return await this.downloading;
  }

  /** Load model + context, or reuse the warm one. */
  private async ensureLoaded(): Promise<Loaded> {
    if (this.loaded) return this.loaded;
    if (this.loading) return await this.loading;

    this.loading = (async (): Promise<Loaded> => {
      this.state = 'loading';
      this.lastError = null;

      if (!existsSync(this.modelPath)) {
        this.state = 'absent';
        throw new ChatError(
          'not_ready',
          `Model not found at ${this.modelPath}. Download it from the Chat tab.`,
        );
      }

      // Lazy import: the rest of InfAgent must keep working when the native
      // dependency is missing (a fresh checkout before `npm install`).
      const llamaModule = await import('node-llama-cpp').catch((error: unknown): never => {
        this.state = 'unavailable';
        this.lastError = error instanceof Error ? error.message : String(error);
        throw new ChatError(
          'unavailable',
          'node-llama-cpp is not installed. Run `npm install` to enable the local model.',
        );
      });

      try {
        const llama = await llamaModule.getLlama({ gpu: false });
        const model = await llama.loadModel({ modelPath: this.modelPath, gpuLayers: 0 });
        const context = await model.createContext({
          contextSize: this.contextSize,
          threads: this.threads,
        });

        // The wrapper comes from the model's settings file: Qwen3 GGUFs ship a
        // Jinja template that llama.cpp stops on immediately, so ChatML is the
        // safe default while other models can opt out.
        const wrapper = this.store.activeContext().chatWrapper;
        const chatWrapper =
          wrapper === 'qwen'
            ? new llamaModule.QwenChatWrapper({})
            : wrapper === 'auto'
              ? undefined
              : new llamaModule.ChatMLChatWrapper();

        this.loaded = {
          llama,
          model,
          context,
          sequence: context.getSequence(),
          chatWrapper,
        };
        this.state = 'ready';
        this.touchIdleTimer();
        return this.loaded;
      } catch (error) {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        throw new ChatError('not_ready', `Could not load the model: ${this.lastError}`);
      } finally {
        this.loading = null;
      }
    })();

    return await this.loading;
  }

  /** Free the model when nobody has used it for a while. */
  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleUnloadMs <= 0) return;
    this.idleTimer = setTimeout(() => void this.unload(), this.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  public async unload(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    const loaded = this.loaded;
    this.loaded = null;
    this.sessionCache = null; // its context sequence dies with the model
    this.state = existsSync(this.modelPath) ? 'idle' : 'absent';
    if (!loaded) return;

    try {
      await loaded.context.dispose();
      await loaded.model.dispose();
    } catch {
      /* disposal races are harmless */
    }
  }

  /**
   * Run one chat turn: stream tokens, execute any tool calls the model emits
   * (up to `maxToolIterations` extra turns), then finish.
   */
  public async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    if (this.busy) {
      throw new ChatError(
        'busy',
        'The model is already generating a reply — wait for it to finish.',
      );
    }
    this.busy = true;

    const startedAt = Date.now();
    let totalTokens = 0;
    // Alerts raised while this turn runs are forwarded to the caller, so a
    // toast appears the moment showAlert fires. Declared outside the `try`
    // because a `finally` block cannot see the `try` block's own bindings.
    const pendingAlerts: Alert[] = [];
    const stopAlerts = this.alerts.subscribe((alert) => pendingAlerts.push(alert));

    try {
      const loaded = await this.ensureLoaded();
      this.touchIdleTimer();
      yield { type: 'status', state: 'ready' };

      const history = request.messages.filter((message) => message.role !== 'system');
      const lastUserIndex = history.map((message) => message.role).lastIndexOf('user');
      const lastUser = lastUserIndex === -1 ? undefined : history[lastUserIndex];
      if (!lastUser) throw new ChatError('not_ready', 'No user message to answer.');

      const model = this.store.activeContext();
      const defaults = {
        temperature: model.temperature,
        maxTokens: model.maxTokens,
        thinking: model.thinking,
        style: model.style,
      };

      const useTools = request.tools !== false && this.allowRun;
      /**
       * Which tool protocol applies. `strict-json` (default) is one JSON
       * envelope per reply; `native` keeps the model's own trained call shape;
       * `legacy` restores the pre-protocol wording. See `protocol.ts`.
       */
      const protocolMode: ProtocolMode = useTools
        ? resolveProtocolMode(model.toolProtocol)
        : 'legacy';
      const strict = protocolMode === 'strict-json';
      const thinking = request.thinking ?? defaults.thinking;
      // Internet access is a per-request switch so the interface can turn it off.
      const net = request.net ?? netEnabled();
      const mcpTools = this.mcp
        ? this.mcp.tools().map(({ server, tool }) => ({
            server,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
        : [];
      // The style guide is the user's choice: an explicit `promptTemplate` on the
      // request wins, otherwise the template selected in the console applies.
      const styleGuide =
        request.promptTemplate !== undefined
          ? request.promptTemplate.trim()
          : (this.prompts?.activePrompt() ?? '');
      /**
       * The toolbox as the grammar and the parser see it — built from the same
       * sources as the prompt listing (`toolboxNames` mirrors it exactly).
       */
      const toolNames = useTools
        ? toolboxNames({ records: this.registry.list(), net, mcp: mcpTools })
        : [];
      /** Steps this reply may take: several calls, results, more calls, answer. */
      const maxSteps = stepBudget(request.maxToolIterations);

      const systemPrompt =
        request.systemPrompt?.trim() ||
        [
          model.agentPrompt,
          buildSystemPrompt({
            records: this.registry.list(),
            tools: useTools,
            thinking,
            style: model.style,
            protocol: protocolMode,
            maxSteps,
            styleGuide,
            // Tool declarations are a per-turn cost. At ~3.2 characters per
            // token this leaves most of a small window to the conversation.
            toolBudget: Math.max(1800, Math.min(7000, Math.round(model.contextSize * 1.35))),
            net: useTools && net,
            skills: this.skills.listing(),
            mcp: useTools ? mcpTools : [],
          }),
        ]
          .filter(Boolean)
          .join('\n\n');
      // `/no_think` is a Qwen3-only soft switch: sending it to Hammer2.1 or
      // xLAM would just be stray text at the end of the user turn.
      const prompt =
        thinking || model.style !== 'qwen3' ? lastUser.content : `${lastUser.content}\n/no_think`;

      const session = await this.sessionFor(loaded, systemPrompt, history.slice(0, lastUserIndex));
      if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
        const rendered = session
          .getChatHistory()
          .map((item: { type: string }) => item.type)
          .join(',');
        process.stderr.write(
          `[chat] system ${systemPrompt.length} chars · history [${rendered}] · tools=${useTools}\n` +
            `[chat] system head: ${systemPrompt.slice(0, 160).replace(/\n/g, '⏎')}\n`,
        );
      }
      // Qwen3 spends 150-250 tokens on a reasoning block before answering, so the
      // budget must cover thinking *and* the reply, or the visible answer is cut off.
      const requestedMaxTokens = request.maxTokens ?? defaults.maxTokens;
      const temperature = request.temperature ?? defaults.temperature;

      /** Characters one chat-history item contributes to the prompt. */
      const historyChars = (item: unknown): number => {
        const record = item as { text?: unknown; content?: unknown };
        if (typeof record?.text === 'string') return record.text.length;
        if (typeof record?.content === 'string') return record.content.length;
        if (Array.isArray(record?.content)) {
          return record.content.reduce((sum: number, part) => sum + historyChars(part), 0);
        }
        return 0;
      };

      /**
       * How many tokens this generation may spend.
       *
       * llama.cpp shifts context when prompt + generation exceed the window, and
       * it gives up entirely when even the system message does not fit. Clamping
       * the budget to the room that is actually left keeps every turn viable.
       * The ratio is a deliberate overshoot (~3.2 characters per token) so the
       * estimate errs on the safe side.
       */
      /** Tokens a reply must be able to spend before the window is "full". */
      const MIN_REPLY_TOKENS = 320;

      const tokenBudget = (prompt: string): number => {
        const history = session.getChatHistory();
        const chars =
          history.reduce((sum: number, item: unknown) => sum + historyChars(item), 0) +
          prompt.length +
          256;
        const room = model.contextSize - Math.ceil(chars / 3.2) - 96;
        return Math.max(MIN_REPLY_TOKENS, Math.min(requestedMaxTokens, room));
      };

      /**
       * Keep the whole turn inside the window.
       *
       * A reply that has only a few dozen tokens left is cut off mid-JSON, which
       * wastes the turn and the repair that follows. Dropping the oldest turns
       * (the newest are the ones the task needs) buys the reply its room back;
       * the tool results of this reply stay in the prompt regardless.
       */
      const fitHistory = (prompt: string): void => {
        const cost = (items: unknown[]): number =>
          items.reduce((sum: number, item: unknown) => sum + historyChars(item), 0);
        const limit = model.contextSize * 3.2;
        const items = session.getChatHistory();
        const fixed = prompt.length + MIN_REPLY_TOKENS * 3.2 + 512;
        if (cost(items) + fixed <= limit || items.length <= 2) return;
        for (let drop = 2; drop < items.length - 1; drop += 2) {
          const kept = items.slice(drop);
          if (cost(kept) + fixed <= limit || kept.length <= 1) {
            if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
              process.stderr.write(`[chat] history: dropped the oldest ${drop} item(s)\n`);
            }
            session.setChatHistory(kept as typeof items);
            return;
          }
        }
        session.setChatHistory(items.slice(-1) as typeof items);
      };
      const splitter = new OutputSplitter();
      const channel = new EventChannel<ChatEvent>();
      /** Visible assistant text for the whole turn (thinking and tool blocks excluded). */
      let visibleText = '';
      let lastTool: ToolOutcome | null = null;
      /** Every call of this reply, so results of several steps can be merged. */
      const facts: MergedFact[] = [];
      /** Correction turns spent in this reply (telemetry, shown in the stats). */
      let repairs = 0;

      /**
       * The constrained-decoding grammar, built once per toolbox.
       *
       * With it on, a reply that is not one of the two envelopes — or that calls
       * a tool that was not offered — cannot be generated at all. It is a
       * best-effort optimisation: if llama.cpp refuses the schema, the parser
       * and the repair turn still hold the contract.
       */
      let cachedGrammar: LlamaGrammar | null = null;
      let cachedGrammarKey = '';
      const grammarFor = async (): Promise<LlamaGrammar | null> => {
        if (!strict || !grammarEnabled() || toolNames.length === 0) return null;
        const key = toolNames.join('\u0000');
        if (cachedGrammar && cachedGrammarKey === key) return cachedGrammar;
        try {
          cachedGrammar = await loaded.llama.createGrammarForJsonSchema(
            envelopeGrammarSchema(toolNames) as never,
          );
          cachedGrammarKey = key;
          return cachedGrammar;
        } catch (error) {
          if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
            process.stderr.write(
              `[chat] grammar unavailable, falling back to the parser: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          }
          return null;
        }
      };
      const grammar = strict ? await grammarFor() : null;

      /** Generate, forwarding splitter events as they arrive; return raw text. */
      const runGeneration = async function* (
        prompt: string,
        override?: LlamaGrammar | null,
      ): AsyncGenerator<ChatEvent, string> {
        let raw = '';
        // One decoder per generation: every generation is a fresh envelope.
        const protocolStream = strict ? new ProtocolStream() : null;
        fitHistory(prompt);
        const budget = tokenBudget(prompt);
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
          process.stderr.write(
            `[chat] budget: ${budget} tokens (window ${model.contextSize}, prompt ${prompt.length} chars)\n`,
          );
        }
        const activeGrammar = override ?? grammar;
        const work = session
          .prompt(prompt, {
            maxTokens: budget,
            temperature,
            ...(activeGrammar ? { grammar: activeGrammar } : {}),
            ...(signal ? { signal, stopOnAbortSignal: true } : {}),
            onToken: (tokens: Token[]) => {
              totalTokens += tokens.length;
            },
            onTextChunk: (chunk: string) => {
              raw += chunk;
              if (protocolStream) {
                for (const event of protocolStream.push(chunk)) channel.push(event);
                return;
              }
              for (const event of splitter.push(chunk)) channel.push(event);
            },
          })
          // The flush runs inside the promise, so the events it releases are
          // drained before the caller sees the generation finish.
          .then((value: string) => {
            if (protocolStream) {
              for (const event of protocolStream.flush()) channel.push(event);
            }
            return value;
          });

        for await (const event of channel.drain(work)) {
          if (event.type === 'token') visibleText += event.text;
          yield event;
        }

        const result = await work;
        const text = result || raw;
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
          process.stderr.write(`[chat] pass (${text.length} chars): ${text.replace(/\n/g, '⏎')}\n`);
        }
        return text;
      };

      const knownScripts = this.registry.list().map((record) => record.meta.name);
      /** The lenient parser: the salvage path and the `native` convention. */
      const lenientCalls = (text: string): ChatToolCall[] =>
        useTools ? extractToolCalls(text, { knownScripts }).calls : [];

      /** Calls the envelope carries, when it is a `tool_call`. */
      const envelopeCalls = (result: ParseResult | null): ChatToolCall[] =>
        result?.ok && result.envelope.type === 'tool_call'
          ? result.envelope.calls.map((call) => ({ name: call.name, args: call.arguments }))
          : [];

      /**
       * Calls for a finished reply: the envelope decides. A reply that is not
       * an envelope at all is read by the lenient parser instead, so a model
       * that ignores the contract still gets its calls executed.
       */
      const readCalls = (text: string, result: ParseResult | null): ChatToolCall[] => {
        if (!useTools) return [];
        return result?.ok ? envelopeCalls(result) : lenientCalls(text);
      };

      /**
       * Generate one reply and hold it to the protocol.
       *
       * A reply that does not parse costs one correction turn — at most
       * `MAX_REPAIRS` of them, each carrying the exact reason it was rejected.
       */
      const generate = async function* (
        text: string,
        override?: LlamaGrammar | null,
      ): AsyncGenerator<
        ChatEvent,
        { combined: string; parsed: ParseResult | null; calls: ChatToolCall[]; answer: string }
      > {
        let combined = yield* runGeneration(text, override);
        let parsed = strict ? parseEnvelope(combined, { toolNames }) : null;
        let spent = 0;

        while (strict && parsed && !parsed.ok && spent < MAX_REPAIRS) {
          spent += 1;
          repairs += 1;
          if (process.env['INFAGENT_CHAT_DEBUG'] === '1') {
            process.stderr.write(`[chat] protocol repair ${spent}: ${parsed.reason}\n`);
          }
          yield { type: 'reset' };
          visibleText = '';
          combined = yield* runGeneration(envelopeRepairPrompt(parsed.reason), override);
          parsed = strict ? parseEnvelope(combined, { toolNames }) : null;
        }

        const answer =
          parsed?.ok && parsed.envelope.type === 'final' ? parsed.envelope.content : '';
        return { combined, parsed, calls: readCalls(combined, parsed), answer };
      };

      let pass = yield* generate(prompt);
      let calls = pass.calls;

      // A 0.6B model occasionally returns a completely empty completion. One
      // silent retry is far cheaper for the user than a blank bubble.
      if (!visibleText.trim() && calls.length === 0 && !pass.answer) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write('[chat] empty reply, retrying\n');
        yield { type: 'reset' };
        visibleText = '';
        pass = yield* generate(prompt);
        calls = pass.calls;
      }

      // Questions about the toolbox itself are answerable only from the
      // registry, yet the model sometimes replies from the tool listing in its
      // own prompt ("I have scripts available."). Nudge it once instead of
      // showing that vague answer.
      // Which registry the question is about — scripts/tools or the skill
      // library — or `null` when it is not about the agent's own inventory.
      const wanted = useTools ? askedListing(lastUser.content) : null;
      const wantedTool = wanted === 'skills' ? 'listSkills' : 'listScripts';

      if (wanted && calls.length === 0) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write(`[chat] ${wanted} question without a call, retrying\n`);
        yield { type: 'reset' };
        visibleText = '';
        pass = yield* generate(
          `${prompt}\n\nCall the ${wantedTool} function now. Reply with exactly this and nothing else:\n` +
            (strict
              ? `{"type":"tool_call","calls":[{"name":"${wantedTool}","arguments":{}}]}`
              : `<tool_call>\n{"name": "${wantedTool}", "arguments": {}}\n</tool_call>`),
        );
        calls = pass.calls;
      }

      // The model answered a toolbox question twice without calling the tool.
      // The registry knows the answer, so supply it rather than showing a vague
      // sentence; the wording still comes from the model below.
      if (wanted && calls.length === 0) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write(`[chat] running ${wantedTool} for an ungrounded answer\n`);
        calls = [{ name: wantedTool, args: {} }];
      }

      // The envelope's `content` is the answer; what streamed can differ after
      // a repair, so the parsed text is what the user is left with.
      if (strict && pass.answer && stripJsonBlobs(visibleText).trim() !== pass.answer.trim()) {
        yield { type: 'reset' };
        visibleText = pass.answer;
        yield { type: 'token', text: pass.answer };
      }

      let iteration = 0;
      /** Every call this reply already made, so a later step can merge results. */
      const progress: { step: number; call: string; result: unknown }[] = [];

      /** The plan the reply carried for the calls that are about to run. */
      const planOf = (current: typeof pass): string =>
        current.parsed?.ok && current.parsed.envelope.type === 'tool_call'
          ? (current.parsed.envelope.plan ?? '')
          : '';
      /** Results already produced this turn, so a repeated call is not re-run. */
      const memo = new Map<
        string,
        { rendered: string; outcome: { ok: boolean; result: unknown } }
      >();

      while (calls.length > 0 && iteration < maxSteps) {
        iteration += 1;
        // The model's own words for what this step is for.
        const plan = planOf(pass);
        if (plan) yield { type: 'plan', text: plan, step: iteration };
        const results: string[] = [];
        /** Ordinary outcomes, so the injected `tool_result` carries real values. */
        const outcomes: Outcome[] = [];

        for (const call of calls) {
          const signature = `${call.name}:${JSON.stringify(call.args)}`;
          const cached = memo.get(signature);
          if (cached !== undefined) {
            results.push(`${call.name} → ${cached}`);
            outcomes.push({ ...cached.outcome, name: call.name });
            continue;
          }

          yield { type: 'tool_call', call };
          const dispatched = await dispatchTool(call, {
            registry: this.registry,
            allowRun: this.allowRun,
            skills: this.skills,
            net,
            alerts: this.alerts,
            ...(this.mcp ? { mcp: this.mcp } : {}),
          });
          yield { type: 'tool_result', call: dispatched };
          for (const alert of pendingAlerts.splice(0)) yield { type: 'alert', alert };
          lastTool = {
            name: dispatched.name,
            ok: dispatched.ok === true,
            ...(dispatched.ok === true ? { result: dispatched.result } : {}),
            ...(dispatched.ok === true ? {} : { error: String(dispatched.error ?? 'failed') }),
          };

          const rendered = dispatched.ok
            ? formatToolResult(dispatched.result)
            : `ERROR: ${dispatched.error ?? 'failed'}`;
          const outcome: Outcome = {
            name: call.name,
            ok: dispatched.ok === true,
            result: dispatched.ok === true ? dispatched.result : (dispatched.error ?? 'failed'),
          };
          memo.set(signature, { rendered, outcome });
          progress.push({
            step: iteration,
            call: `${call.name}(${JSON.stringify(call.args)})`,
            result: outcome.result,
          });
          facts.push({
            tool: call.name,
            args: JSON.stringify(call.args ?? {}),
            ok: outcome.ok,
            result: outcome.result,
          });
          // The prompt gets the readable view (names first), not a nested dump.
          results.push(
            `${call.name} → ${dispatched.ok === true ? readableResult(dispatched.result) : rendered}`,
          );
        }

        // The runtime — not the model — says what the tools answered, and the
        // payload is a `tool_result` object the model can only read.
        const envelope = strict
          ? resultEnvelope(
              calls.map((call, index) => {
                const outcome = outcomes[index];
                return {
                  name: call.name,
                  ok: outcome?.ok ?? false,
                  result: outcome?.result ?? null,
                };
              }),
            )
          : undefined;
        pass = yield* generate(
          toolResultPrompt(results, lastUser.content, {
            ...(envelope ? { envelope } : {}),
            progress: progressPrompt(progress),
            stepsLeft: Math.max(0, maxSteps - iteration),
            // The user's own paths, minus the ones a call has already used: a
            // small model stops after the first folder unless it is told.
            remaining: unusedRequestPaths(
              lastUser.content,
              facts.map((fact) => fact.args),
            ),
          }),
        );
        calls = pass.calls.filter((call) => !memo.has(`${call.name}:${JSON.stringify(call.args)}`));
      }

      if (calls.length > 0) {
        // The model asked for more work than the reply may do. Rather than
        // leaving a dangling call, take one answer-only turn with the grammar
        // that makes another call impossible, so the user gets what the results
        // already say.
        yield {
          type: 'plan',
          text: `Step limit (${maxSteps}) reached — answering with the results so far.`,
          step: maxSteps + 1,
        };
        let answerGrammar: LlamaGrammar | null = null;
        if (strict && grammarEnabled()) {
          try {
            answerGrammar = await loaded.llama.createGrammarForJsonSchema(
              finalOnlyGrammarSchema() as never,
            );
          } catch {
            answerGrammar = null;
          }
        }
        pass = yield* generate(
          finalAnswerPrompt(lastUser.content, progressPrompt(progress)),
          answerGrammar,
        );
      }

      for (const event of splitter.flush()) yield event;

      // The runtime — not the model — is the authority on what a tool returned.
      // A reply that ignores the payload gets the facts appended; one that
      // contradicts it ("there are no scripts" over a six-script list, or a
      // silent failure) is replaced by them.
      const guard = guardToolAnswer(stripJsonBlobs(visibleText).trim(), lastTool, {
        facts,
        question: lastUser.content,
      });
      if (guard.kind === 'append') {
        yield { type: 'token', text: `${visibleText.trim() ? '\n\n' : ''}${guard.text}` };
      } else if (guard.kind === 'replace') {
        yield { type: 'reset' };
        visibleText = guard.text;
        yield { type: 'token', text: guard.text };
      }

      if (!stripJsonBlobs(visibleText).trim() && !lastTool) {
        yield { type: 'token', text: 'The model could not produce an answer — please try again.' };
      }

      const durationMs = Date.now() - startedAt;
      yield {
        type: 'stats',
        totalTokens,
        tokensPerSecond:
          durationMs > 0 ? Number(((totalTokens / durationMs) * 1000).toFixed(1)) : 0,
        durationMs,
        ...(repairs > 0 ? { repairs } : {}),
      };
      // Alerts raised after the last tool result still reach the caller.
      for (const alert of pendingAlerts.splice(0)) yield { type: 'alert', alert };

      yield { type: 'done' };
    } finally {
      stopAlerts();
      this.busy = false;
      this.touchIdleTimer();
    }
  }

  /**
   * Reuse the warm session when the incoming history continues the one it holds,
   * otherwise rebuild it (and drop the stale one). Keeps multi-turn chat fast.
   */
  private async sessionFor(
    loaded: Loaded,
    systemPrompt: string,
    priorTurns: readonly ChatMessage[],
  ): Promise<LlamaChatSession> {
    const fingerprint = JSON.stringify([systemPrompt, priorTurns]);
    if (this.sessionCache?.fingerprint === fingerprint) return this.sessionCache.session;

    const session = await this.createSession(loaded, systemPrompt, priorTurns);
    this.sessionCache = { fingerprint, session };
    return session;
  }

  private async createSession(
    loaded: Loaded,
    systemPrompt: string,
    priorTurns: readonly ChatMessage[],
  ): Promise<LlamaChatSession> {
    const { LlamaChatSession } = await import('node-llama-cpp');
    const session = new LlamaChatSession({
      contextSequence: loaded.sequence,
      chatWrapper: loaded.chatWrapper as never,
      systemPrompt,
      // Long chats: drop the oldest turns but always keep the system prompt,
      // which carries the tool definitions.
      contextShift: { strategy: 'eraseFirstResponseAndKeepFirstSystem' },
    });

    if (priorTurns.length > 0) {
      session.setChatHistory([
        { type: 'system', text: systemPrompt },
        ...priorTurns.map((message) =>
          message.role === 'assistant'
            ? ({ type: 'model', response: [message.content] } as never)
            : ({ type: 'user', text: message.content } as never),
        ),
      ]);
    }

    return session;
  }
}

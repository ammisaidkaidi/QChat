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
import {
  answerUsesResult,
  asksAboutToolbox,
  buildSystemPrompt,
  fallbackAnswer,
  formatToolResult,
  stripJsonBlobs,
  toolResultPrompt,
} from './prompt.js';
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
      };

      const useTools = request.tools !== false && this.allowRun;
      const thinking = request.thinking ?? defaults.thinking;
      // Internet access is a per-request switch so the interface can turn it off.
      const net = request.net ?? netEnabled();
      const mcpTools = this.mcp
        ? this.mcp.tools().map(({ server, tool }) => ({
            server,
            name: tool.name,
            description: tool.description,
          }))
        : [];
      const systemPrompt =
        request.systemPrompt?.trim() ||
        [
          model.agentPrompt,
          buildSystemPrompt({
            records: this.registry.list(),
            tools: useTools,
            thinking,
            net: useTools && net,
            skills: this.skills.listing(),
            mcp: useTools ? mcpTools : [],
          }),
        ]
          .filter(Boolean)
          .join('\n\n');
      const prompt = thinking ? lastUser.content : `${lastUser.content}\n/no_think`;

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
      const maxTokens = request.maxTokens ?? defaults.maxTokens;
      const temperature = request.temperature ?? defaults.temperature;
      const splitter = new OutputSplitter();
      const channel = new EventChannel<ChatEvent>();
      /** Visible assistant text for the whole turn (thinking and tool blocks excluded). */
      let visibleText = '';
      let lastTool: { name: string; result: unknown } | null = null;

      /** Generate, forwarding splitter events as they arrive; return raw text. */
      const runGeneration = async function* (prompt: string): AsyncGenerator<ChatEvent, string> {
        let raw = '';
        const work = session.prompt(prompt, {
          maxTokens,
          temperature,
          ...(signal ? { signal, stopOnAbortSignal: true } : {}),
          onToken: (tokens: Token[]) => {
            totalTokens += tokens.length;
          },
          onTextChunk: (chunk: string) => {
            raw += chunk;
            for (const event of splitter.push(chunk)) channel.push(event);
          },
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
      const readCalls = (text: string): ChatToolCall[] =>
        useTools ? extractToolCalls(text, { knownScripts }).calls : [];

      let combined = yield* runGeneration(prompt);
      let calls = readCalls(combined);

      // A 0.6B model occasionally returns a completely empty completion. One
      // silent retry is far cheaper for the user than a blank bubble.
      if (!visibleText.trim() && calls.length === 0) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write('[chat] empty reply, retrying\n');
        yield { type: 'reset' };
        visibleText = '';
        combined = yield* runGeneration(prompt);
        calls = readCalls(combined);
      }

      // Questions about the toolbox itself are answerable only from the
      // registry, yet the model sometimes replies from the tool listing in its
      // own prompt ("I have scripts available."). Nudge it once instead of
      // showing that vague answer.
      if (useTools && calls.length === 0 && asksAboutToolbox(lastUser.content)) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write('[chat] toolbox question without a call, retrying\n');
        yield { type: 'reset' };
        visibleText = '';
        combined = yield* runGeneration(
          `${prompt}\n\nCall the listScripts function now. Reply with exactly this and nothing else:\n` +
            '<tool_call>\n{"name": "listScripts", "arguments": {}}\n</tool_call>',
        );
        calls = readCalls(combined);
      }

      // The model answered a toolbox question twice without calling the tool.
      // The registry knows the answer, so supply it rather than showing a vague
      // sentence; the wording still comes from the model below.
      if (useTools && calls.length === 0 && asksAboutToolbox(lastUser.content)) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write('[chat] running listScripts for an ungrounded answer\n');
        calls = [{ name: 'listScripts', args: {} }];
      }

      let iteration = 0;
      const maxIterations = Math.min(request.maxToolIterations ?? 2, 4);
      /** Results already produced this turn, so a repeated call is not re-run. */
      const memo = new Map<string, string>();

      while (calls.length > 0 && iteration < maxIterations) {
        iteration += 1;
        const results: string[] = [];

        for (const call of calls) {
          const signature = `${call.name}:${JSON.stringify(call.args)}`;
          const cached = memo.get(signature);
          if (cached !== undefined) {
            results.push(`${call.name} → ${cached}`);
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
            result: dispatched.ok ? dispatched.result : dispatched.error,
          };

          const rendered = dispatched.ok
            ? formatToolResult(dispatched.result)
            : `ERROR: ${dispatched.error ?? 'failed'}`;
          memo.set(signature, rendered);
          results.push(`${call.name} → ${rendered}`);
        }

        combined = yield* runGeneration(toolResultPrompt(results, lastUser.content));
        calls = readCalls(combined).filter(
          (call) => !memo.has(`${call.name}:${JSON.stringify(call.args)}`),
        );
      }

      for (const event of splitter.flush()) yield event;

      // A 0.6B model sometimes answers with an empty string or echoes the raw JSON
      // payload. Guarantee the user still sees the outcome of the tool call.
      const cleaned = stripJsonBlobs(visibleText).trim();
      if (
        lastTool &&
        (cleaned.length === 0 ||
          (cleaned.length < 12 && visibleText.includes('{')) ||
          !answerUsesResult(cleaned, lastTool.result))
      ) {
        yield {
          type: 'token',
          text: `${visibleText.trim() ? '\n\n' : ''}${fallbackAnswer(lastTool.name, lastTool.result)}`,
        };
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

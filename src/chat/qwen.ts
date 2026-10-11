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
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import type {
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
  Token,
} from 'node-llama-cpp';

import { ScriptRegistry } from '../scripts/registry.js';
import {
  buildSystemPrompt,
  fallbackAnswer,
  formatToolResult,
  stripJsonBlobs,
  toolResultPrompt,
} from './prompt.js';
import { OutputSplitter } from './splitter.js';
import { dispatchTool, extractToolCalls } from './tools.js';
import type { ChatEvent, ChatMessage, ChatRequest, EngineState, EngineStatus } from './types.js';

export const DEFAULT_MODEL = {
  repo: 'unsloth/Qwen3-0.6B-GGUF',
  file: 'Qwen3-0.6B-Q4_K_M.gguf',
  quantization: 'Q4_K_M',
  url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf',
} as const;

export const DEFAULT_MODELS_DIR = join(homedir(), '.cache', 'infagent', 'models');

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
  modelsDir?: string;
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
  public readonly modelsDir: string;
  public readonly modelPath: string;
  public readonly modelUrl: string;
  public readonly contextSize: number;
  public readonly threads: number;
  private readonly idleUnloadMs: number;
  private readonly allowRun: boolean;

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
    this.modelsDir = resolve(
      options.modelsDir ?? process.env['INFAGENT_MODELS_DIR'] ?? DEFAULT_MODELS_DIR,
    );
    this.modelPath = resolve(
      options.modelPath ??
        process.env['INFAGENT_MODEL_PATH'] ??
        join(this.modelsDir, DEFAULT_MODEL.file),
    );
    this.modelUrl = options.modelUrl ?? process.env['INFAGENT_MODEL_URL'] ?? DEFAULT_MODEL.url;
    this.contextSize = options.contextSize ?? Number(process.env['INFAGENT_LLM_CONTEXT'] ?? 2048);
    this.threads = options.threads ?? Number(process.env['INFAGENT_LLM_THREADS'] ?? 2);
    this.idleUnloadMs =
      options.idleUnloadMs ?? Number(process.env['INFAGENT_LLM_IDLE_UNLOAD_MS'] ?? 600_000);
    this.allowRun = options.allowRun ?? process.env['INFAGENT_ALLOW_RUN'] !== '0';
    this.state = existsSync(this.modelPath) ? 'idle' : 'absent';
  }

  public status(): EngineStatus {
    const present = existsSync(this.modelPath);
    return {
      state: this.state === 'idle' && this.loaded ? 'ready' : this.state,
      modelPath: this.modelPath,
      modelPresent: present,
      modelBytes: present ? statSync(this.modelPath).size : 0,
      modelUrl: this.modelUrl,
      downloadProgress: this.downloadProgress,
      downloadedBytes: this.downloadedBytes,
      downloadTotalBytes: this.downloadTotalBytes,
      contextSize: this.contextSize,
      threads: this.threads,
      modelName: `Qwen3-0.6B (${DEFAULT_MODEL.quantization})`,
      quantization: DEFAULT_MODEL.quantization,
      toolsAvailable: this.allowRun,
      ramUsedMb: Math.round(process.memoryUsage().rss / 1048576),
      lastError: this.lastError,
    };
  }

  public isLoaded(): boolean {
    return this.loaded !== null;
  }

  public isBusy(): boolean {
    return this.busy;
  }

  /** Download the GGUF into `modelsDir`, reporting progress through `status()`. */
  public async downloadModel(): Promise<string> {
    if (this.downloading) return await this.downloading;

    this.downloading = (async (): Promise<string> => {
      this.state = 'downloading';
      this.lastError = null;
      this.downloadProgress = 0;
      this.downloadedBytes = 0;
      this.downloadTotalBytes = 0;

      try {
        const { createModelDownloader } = await import('node-llama-cpp');
        const downloader = await createModelDownloader({
          modelUrl: this.modelUrl,
          dirPath: this.modelsDir,
          fileName: basename(this.modelPath),
          onProgress: ({ totalSize, downloadedSize }) => {
            this.downloadTotalBytes = totalSize;
            this.downloadedBytes = downloadedSize;
            this.downloadProgress = totalSize > 0 ? Math.min(1, downloadedSize / totalSize) : 0;
          },
        });

        const file = await downloader.download();
        this.downloadProgress = 1;
        this.state = 'idle';
        return file;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.state = existsSync(this.modelPath) ? 'idle' : 'error';
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

        this.loaded = {
          llama,
          model,
          context,
          sequence: context.getSequence(),
          chatWrapper: new llamaModule.ChatMLChatWrapper(),
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

    try {
      const loaded = await this.ensureLoaded();
      this.touchIdleTimer();
      yield { type: 'status', state: 'ready' };

      const history = request.messages.filter((message) => message.role !== 'system');
      const lastUserIndex = history.map((message) => message.role).lastIndexOf('user');
      const lastUser = lastUserIndex === -1 ? undefined : history[lastUserIndex];
      if (!lastUser) throw new ChatError('not_ready', 'No user message to answer.');

      const useTools = request.tools !== false && this.allowRun;
      const systemPrompt =
        request.systemPrompt?.trim() ||
        buildSystemPrompt({
          records: this.registry.list(),
          tools: useTools,
          thinking: request.thinking ?? false,
        });

      const thinking = request.thinking ?? false;
      const prompt = thinking ? lastUser.content : `${lastUser.content}\n/no_think`;

      const session = await this.sessionFor(loaded, systemPrompt, history.slice(0, lastUserIndex));
      // Qwen3 spends 150-250 tokens on a reasoning block before answering, so the
      // budget must cover thinking *and* the reply, or the visible answer is cut off.
      const maxTokens = request.maxTokens ?? 512;
      const temperature = request.temperature ?? 0.4;
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

      let combined = yield* runGeneration(prompt);

      // A 0.6B model occasionally returns a completely empty completion. One
      // silent retry is far cheaper for the user than a blank bubble.
      if (!visibleText.trim() && extractToolCalls(combined).calls.length === 0) {
        if (process.env['INFAGENT_CHAT_DEBUG'] === '1')
          process.stderr.write('[chat] empty reply, retrying\n');
        combined = yield* runGeneration(prompt);
      }

      let iteration = 0;
      const maxIterations = Math.min(request.maxToolIterations ?? 2, 4);
      let calls = useTools ? extractToolCalls(combined).calls : [];
      /** Results already produced this turn, so a repeated call is not re-run. */
      const memo = new Map<string, string>();

      while (calls.length > 0 && iteration < maxIterations) {
        iteration += 1;
        const results: string[] = [];

        for (const call of calls) {
          const signature = `${call.name}:${JSON.stringify(call.args)}`;
          const cached = memo.get(signature);
          if (cached !== undefined) {
            results.push(`- ${call.name} → ${cached}`);
            continue;
          }

          yield { type: 'tool_call', call };
          const dispatched = await dispatchTool(call, {
            registry: this.registry,
            allowRun: this.allowRun,
          });
          yield { type: 'tool_result', call: dispatched };
          lastTool = {
            name: dispatched.name,
            result: dispatched.ok ? dispatched.result : dispatched.error,
          };

          const rendered = dispatched.ok
            ? formatToolResult(dispatched.result)
            : `ERROR: ${dispatched.error ?? 'failed'}`;
          memo.set(signature, rendered);
          results.push(`- ${call.name} → ${rendered}`);
        }

        combined = yield* runGeneration(toolResultPrompt(results, lastUser.content));
        calls = extractToolCalls(combined).calls.filter(
          (call) => !memo.has(`${call.name}:${JSON.stringify(call.args)}`),
        );
      }

      for (const event of splitter.flush()) yield event;

      // A 0.6B model sometimes answers with an empty string or echoes the raw JSON
      // payload. Guarantee the user still sees the outcome of the tool call.
      const cleaned = stripJsonBlobs(visibleText).trim();
      if (
        lastTool &&
        (cleaned.length === 0 || (cleaned.length < 12 && visibleText.includes('{')))
      ) {
        yield {
          type: 'token',
          text: `${visibleText.trim() ? ' ' : ''}${fallbackAnswer(lastTool.name, lastTool.result)}`,
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
      yield { type: 'done' };
    } finally {
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

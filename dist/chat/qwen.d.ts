import type { McpManager } from '../mcp/manager.js';
import { AlertBus } from '../capabilities/alerts.js';
import { ScriptRegistry } from '../scripts/registry.js';
import { SkillRegistry } from '../skills/registry.js';
import { DEFAULT_MODELS_DIR, ModelStore } from './modelStore.js';
import type { ModelRecord, ModelSettings } from './modelStore.js';
import { SystemPromptStore } from './prompts.js';
import type { ChatEvent, ChatRequest, EngineStatus } from './types.js';
/**
 * The model InfAgent ships with: its settings file is committed under `models/`
 * and the 380 MB of weights are fetched on first use into the weights cache.
 */
export declare const DEFAULT_MODEL: ModelSettings;
export { DEFAULT_MODELS_DIR, ModelStore };
export type { ModelCatalogue, ModelRecord, ModelSettings } from './modelStore.js';
export declare class ChatError extends Error {
    readonly code: 'busy' | 'unavailable' | 'not_ready' | 'download' | 'aborted';
    constructor(code: ChatError['code'], message: string);
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
/**
 * Turns a push-based producer (the token callback) into an async stream, so the
 * browser receives tokens while the model is still generating instead of all at
 * once when the turn ends.
 */
export declare class EventChannel<T> {
    private items;
    private wakeups;
    push(item: T): void;
    drain(work: Promise<unknown>): AsyncGenerator<T>;
}
export declare class QwenEngine {
    readonly registry: ScriptRegistry;
    /** Skill library (`skills/*.md`). */
    readonly skills: SkillRegistry;
    /** MCP servers, if any are configured. */
    readonly mcp: McpManager | null;
    /** Where `showAlert` puts alerts and where the interface reads them from. */
    readonly alerts: AlertBus;
    /** Catalogue over `models/`: which model is used, and how. */
    readonly store: ModelStore;
    /** Selectable system-prompt templates ("way of thinking"). */
    readonly prompts: SystemPromptStore;
    private readonly idleUnloadMs;
    private readonly allowRun;
    /** Explicit overrides; unset values follow the active model's settings. */
    private readonly contextOverride;
    private readonly threadsOverride;
    private readonly urlOverride;
    private loaded;
    /**
     * Warm session cache: re-evaluating the whole conversation on every turn is
     * the dominant cost on a 2-core CPU, so a session is reused while the incoming
     * history still matches the one it was built from (KV cache stays valid).
     */
    private sessionCache;
    private state;
    private lastError;
    private busy;
    private loading;
    private idleTimer;
    private downloadProgress;
    private downloadedBytes;
    private downloadTotalBytes;
    private downloading;
    constructor(options?: QwenEngineOptions);
    /** Folder holding the model settings files. */
    get modelsDir(): string;
    /** Folder the weights live in (outside the repository by default). */
    get weightsDir(): string;
    /** Weights of the active model. */
    get modelPath(): string;
    /** Where the active model is fetched from. */
    get modelUrl(): string;
    /** Context window actually used for the active model. */
    get contextSize(): number;
    /** llama.cpp threads actually used for the active model. */
    get threads(): number;
    /** The active record plus the resolved download URL. */
    private activeModel;
    status(): EngineStatus;
    /** Every model in the catalogue, with the active one flagged. */
    models(): {
        dir: string;
        weightsDir: string;
        active: string;
        models: ModelRecord[];
    };
    /**
     * Switch the active model. The current one is dropped from memory first, so
     * the switch costs nothing but a lazy reload on the next message.
     */
    useModel(id: string): Promise<ModelRecord>;
    /**
     * Forget the current conversation and start the next turn from the system
     * prompt alone. The model stays loaded; only the chat history goes.
     */
    resetSession(): void;
    isLoaded(): boolean;
    isBusy(): boolean;
    /**
     * Fetch a model's weights into the weights folder.
     *
     * Defaults to the active model; its settings file is kept in sync with what
     * actually landed on disk.
     */
    downloadModel(id?: string): Promise<string>;
    /** Load model + context, or reuse the warm one. */
    private ensureLoaded;
    /** Free the model when nobody has used it for a while. */
    private touchIdleTimer;
    unload(): Promise<void>;
    /**
     * Run one chat turn: stream tokens, execute any tool calls the model emits
     * (up to `maxToolIterations` extra turns), then finish.
     */
    stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
    /**
     * Reuse the warm session when the incoming history continues the one it holds,
     * otherwise rebuild it (and drop the stale one). Keeps multi-turn chat fast.
     */
    private sessionFor;
    private createSession;
}
//# sourceMappingURL=qwen.d.ts.map
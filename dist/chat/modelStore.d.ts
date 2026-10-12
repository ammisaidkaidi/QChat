export declare const MODEL_SETTINGS_VERSION = "infagent-model/v1";
export declare const CATALOGUE_VERSION = "infagent-models/v1";
/** Repository root, no matter whether we run from `src/` or `dist/`. */
export declare const PROJECT_ROOT: string;
/** Settings files live in the project's own `models/` folder (committed). */
export declare const DEFAULT_SETTINGS_DIR: string;
/** Weights live in a cache outside the repository: large and reproducible. */
export declare const DEFAULT_WEIGHTS_DIR: string;
/** The catalogue folder — kept under its old name for the public API. */
export declare const DEFAULT_MODELS_DIR: string;
/**
 * How a model is prompted and how it answers tool calls.
 *
 *   `qwen3` (default) — Qwen3 convention: an optional `/no_think` switch and
 *     calls inside `<tool_call>{…}</tool_call>`.
 *   `xlam` — the Hammer2.1 / xLAM convention: no thinking switch, and the reply
 *     is a bare JSON array of calls, `[{"name": …, "arguments": {…}}]`.
 *   `plain` — everything else (Gemma, Llama, SmolLM2, LFM2.5, MiniCPM, …): no
 *     thinking switch either, and the common ChatML/Hermes convention — a
 *     `<tools>` listing plus `<tool_call>{"name": …}</tool_call>`.
 */
export type ModelStyle = 'qwen3' | 'xlam' | 'plain';
export interface ModelSettings {
    version: string;
    /** Stable identifier; also the settings file name. */
    id: string;
    /** Human label shown in the interface. */
    name: string;
    /** GGUF file name, resolved inside the settings or the weights folder. */
    file: string;
    family?: string;
    quantization?: string;
    description?: string;
    /** Where to fetch the weights when the file is missing. */
    source?: {
        url?: string;
        repo?: string;
    };
    sizeBytes?: number;
    /** Runtime defaults — all overridable per request from the interface. */
    contextSize?: number;
    threads?: number;
    temperature?: number;
    maxTokens?: number;
    thinking?: boolean;
    /** Chat wrapper `node-llama-cpp` should use (`chatml` | `qwen` | `auto`). */
    chatWrapper?: 'chatml' | 'qwen' | 'auto';
    /** Prompting / tool-call convention. Defaults to `qwen3`. */
    style?: ModelStyle;
    /** Extra system-prompt text prepended for this model. */
    agentPrompt?: string;
}
export interface ModelRecord {
    settings: ModelSettings;
    /** Absolute path of the weights, whether present or not. */
    path: string;
    /** Absolute path of the settings file. */
    settingsPath: string;
    /** Folder the weights live in (or would live in). */
    weightsDir: string;
    present: boolean;
    sizeBytes: number;
    bytesOnDisk: number;
    active: boolean;
}
export interface ModelCatalogue {
    version: string;
    /** Identifier of the active model. */
    active: string;
    /** Offering order; unknown ids are appended at the end. */
    order: string[];
    /** Name of the selected system-prompt template (`models/systemPrompts.json`). */
    activePrompt?: string;
}
export interface ModelStoreOptions {
    /** Where the settings files live. Defaults to `<root>/models`. */
    dir?: string;
    /** Where the weights live. Defaults to `INFAGENT_WEIGHTS_DIR`, then the cache. */
    weightsDir?: string;
    /** Explicit GGUF path that overrides the catalogue entirely. */
    overridePath?: string;
}
export declare class ModelStore {
    /** Folder holding the settings files (committed). */
    readonly dir: string;
    /** Folder holding the `.gguf` weights (outside the repository). */
    readonly weightsDir: string;
    readonly overridePath: string | null;
    constructor(options?: ModelStoreOptions);
    /** Create both folders if needed; safe to call often. */
    ensureDir(): string;
    private settingsPathFor;
    catalogue(): ModelCatalogue;
    private saveCatalogue;
    /**
     * Every model in the catalogue, with the active one flagged.
     *
     * GGUFs without a settings file get one written on the spot, so a file copied
     * into either folder by hand is usable immediately.
     */
    list(): ModelRecord[];
    /** Effective active id given what is on disk and what the catalogue says. */
    private activeId;
    /** Where a weights file lives: beside the settings, else in the cache. */
    weightsPath(file: string): string;
    private record;
    get(id: string): ModelRecord | null;
    /** The model the engine should load. */
    active(): ModelRecord | null;
    /** Runtime settings the engine should use, with env overrides applied. */
    activeContext(): {
        id: string;
        path: string;
        dir: string;
        weightsDir: string;
        contextSize: number;
        threads: number;
        temperature: number;
        maxTokens: number;
        thinking: boolean;
        chatWrapper: NonNullable<ModelSettings['chatWrapper']>;
        style: ModelStyle;
        agentPrompt: string;
    };
    private number;
    /** Point the catalogue at another model. Returns the new effective model. */
    setActive(id: string): ModelRecord;
    /** Name of the selected system-prompt template, or '' when none is selected. */
    activePrompt(): string;
    /** Remember which system-prompt template the user picked. */
    setActivePrompt(name: string): string;
    /** Sensible settings for a GGUF we know nothing about yet. */
    defaultSettings(id: string, file: string, extra?: Partial<ModelSettings>): ModelSettings;
    /** Write (or refresh) a model's settings file. */
    writeSettings(settings: ModelSettings): string;
    /**
     * Register a model after a download: keeps the settings file in sync with the
     * file that actually landed on disk.
     */
    register(settings: ModelSettings, options?: {
        makeActive?: boolean;
    }): ModelRecord;
}
//# sourceMappingURL=modelStore.d.ts.map
/**
 * Chat-layer types shared by the engine, the HTTP API and the Vue interface.
 */
import type { Alert } from '../capabilities/alerts.js';
export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
    role: ChatRole;
    content: string;
}
export interface ChatToolCall {
    /** Tool name as emitted by the model (`runScript`, or a script name directly). */
    name: string;
    args: Record<string, unknown>;
    /** Normalised result of the dispatch. */
    ok?: boolean;
    result?: unknown;
    error?: string;
    durationMs?: number;
}
/**
 * Server-sent events emitted while a chat turn is generated.
 * `thinking` carries Qwen3's `<think>` block so the UI can fold it away.
 */
export type ChatEvent = {
    type: 'status';
    state: EngineState;
    detail?: string;
} | {
    type: 'thinking';
    text: string;
} | {
    type: 'token';
    text: string;
}
/** Discard the partially streamed reply (the engine is retrying this turn). */
 | {
    type: 'reset';
} | {
    type: 'tool_call';
    call: ChatToolCall;
} | {
    type: 'tool_result';
    call: ChatToolCall;
}
/** The model (or anything else) raised a user-facing alert. */
 | {
    type: 'alert';
    alert: Alert;
} | {
    type: 'stats';
    totalTokens: number;
    tokensPerSecond: number;
    durationMs: number;
} | {
    type: 'done';
} | {
    type: 'error';
    message: string;
};
export interface ChatRequest {
    /** Allow internet capabilities (webSearch/webFetch) for this turn. */
    net?: boolean;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    /** Qwen3 thinking mode. Off by default: a 0.6B model is far snappier without it. */
    thinking?: boolean;
    /** Let the model call the agent script toolbox. */
    tools?: boolean;
    /** Replace the generated system prompt (the script toolbox listing). */
    systemPrompt?: string;
    /** Extra turns of tool calls allowed before the model must answer. */
    maxToolIterations?: number;
    /**
     * System-prompt template for this turn. Omit to use the one selected in the
     * console; send "" to answer with no style guide at all.
     */
    promptTemplate?: string;
}
export type EngineState = 'unavailable' | 'absent' | 'downloading'
/** Model file present but not loaded into memory yet. */
 | 'idle' | 'loading' | 'ready' | 'error';
export interface EngineStatus {
    state: EngineState;
    /** Identifier from the model's settings file. */
    modelId: string;
    /** Model file backing the engine. */
    modelPath: string;
    modelPresent: boolean;
    modelBytes: number;
    /** Where a missing model is fetched from. */
    modelUrl: string;
    /** 0…1 while `state === 'downloading'`. */
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
    /** True when the script toolbox is offered to the model. */
    toolsAvailable: boolean;
    ramUsedMb: number;
    lastError: string | null;
}
//# sourceMappingURL=types.d.ts.map
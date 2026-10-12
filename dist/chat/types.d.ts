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
/**
 * What the model says the current step of a multi-step task is for. It comes
 * from the `plan` field of a `tool_call` envelope; `step` counts the steps of
 * this reply from 1.
 */
 | {
    type: 'plan';
    text: string;
    step?: number;
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
    /** Protocol correction turns spent on this reply (strict-JSON mode only). */
    repairs?: number;
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
    /**
     * Tool steps this reply may take, 1–12 (default 6, `INFAGENT_MAX_STEPS`).
     * One step may call up to four functions; each step's results come back and
     * the model may call more before it answers.
     */
    maxToolIterations?: number;
    /**
     * System-prompt template for this turn. Omit to use the one selected in the
     * console; send "" to answer with no style guide at all.
     */
    promptTemplate?: string;
    /**
     * Skills the user pinned with `/name` in the message box. Each one's body is
     * loaded into this turn's system prompt, so "follow this skill" does not
     * depend on the model deciding to call `readSkill`. Unknown names are
     * ignored (a skill deleted meanwhile must not fail a reply).
     */
    skills?: string[];
    /**
     * MCP servers this turn may use, by name. Omit for every enabled server;
     * `[]` means no MCP tool at all. The selection is enforced here, not asked
     * for in the prompt: a call to a server outside it is refused by the
     * dispatcher, so unticking a server in the console really removes it.
     */
    mcpServers?: string[];
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
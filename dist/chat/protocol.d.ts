import type { ChatEvent } from './types.js';
export type ProtocolMode = 'strict-json' | 'native' | 'legacy';
/** How many correction turns a reply that did not parse is worth. */
export declare const MAX_REPAIRS = 2;
export interface ToolCallRequest {
    name: string;
    arguments: Record<string, unknown>;
}
export type Envelope = {
    type: 'tool_call';
    calls: ToolCallRequest[];
    plan?: string;
} | {
    type: 'final';
    content: string;
};
/** How long the one-line plan of a step may be. */
export declare const MAX_PLAN_CHARS = 240;
/**
 * How many tool steps one reply may take.
 *
 * A multi-step task — "list the files in these three folders and count them" —
 * needs one step per folder plus the answer, so the old default of two cut the
 * work in half. `INFAGENT_MAX_STEPS` tunes it; the request may override.
 */
export declare function stepBudget(requested?: number): number;
/** Steps per reply when neither the request nor the environment say otherwise. */
export declare const DEFAULT_STEPS = 6;
export type ParseResult = {
    ok: true;
    envelope: Envelope;
} | {
    ok: false;
    reason: string;
};
/** Literal examples, shared by the system prompt and the repair turn. */
export declare const TOOL_CALL_EXAMPLE = "{\"type\":\"tool_call\",\"plan\":\"List the scripts first\",\"calls\":[{\"name\":\"listScripts\",\"arguments\":{}}]}";
export declare const FINAL_EXAMPLE = "{\"type\":\"final\",\"content\":\"You have three scripts: hello, system_info, net_interfaces.\"}";
/** The one rule that is about *results*, in the model's words. */
export declare const RESULT_RULE: string;
/**
 * Parse a reply that must be one envelope.
 *
 * `toolNames` is the toolbox as offered to the model in this turn; a call to
 * anything else is rejected here exactly like the grammar rejects it.
 */
export declare function parseEnvelope(text: string, options?: {
    toolNames?: readonly string[];
}): ParseResult;
/**
 * The grammar for a turn that must end in an answer (the step budget is spent).
 * Only `final` is representable, so the model cannot open yet another step.
 */
export declare function finalOnlyGrammarSchema(): Record<string, unknown>;
/**
 * Which protocol applies to this turn.
 *
 * The model's settings file wins (`toolProtocol`), the environment can override
 * every model at once (`INFAGENT_TOOL_PROTOCOL=legacy` is the escape hatch that
 * restores the pre-protocol behaviour), and the default is the strict envelope.
 */
export declare function resolveProtocolMode(preferred?: ProtocolMode): ProtocolMode;
/** Constrained decoding is on unless `INFAGENT_TOOL_GRAMMAR=0` turns it off. */
export declare function grammarEnabled(): boolean;
/**
 * The protocol as a llama.cpp JSON-schema grammar.
 *
 * `enum` on the tool name is what makes a call to an unoffered tool impossible
 * rather than merely unlikely.
 */
export declare function envelopeGrammarSchema(toolNames: readonly string[]): Record<string, unknown>;
/** The correction turn sent when a reply did not parse. */
export declare function envelopeRepairPrompt(reason: string): string;
/** The `tool_result` object the engine injects after running the calls. */
export declare function resultEnvelope(calls: readonly {
    name: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}[]): string;
/**
 * Incremental decoder for a streamed envelope.
 *
 * While the reply is generated this keeps the JSON away from the user and
 * releases exactly the `content` string of a `final` envelope, escapes decoded
 * as they arrive. Anything that is not an envelope — prose, which is what the
 * model answers when no tool is needed and the grammar is off — streams through
 * unchanged, so the interface never loses text.
 */
export declare class ProtocolStream {
    private buffer;
    private state;
    /** Partial escape at the end of the buffer: `\` or `\u`. */
    private escape;
    /** Feed a raw chunk; returns the events it produced. */
    push(chunk: string): ChatEvent[];
    /** End of generation: release what a text reply still holds back. */
    flush(): ChatEvent[];
    private consume;
    /** Decode what has arrived of the `content` string. */
    private takeContent;
}
//# sourceMappingURL=protocol.d.ts.map
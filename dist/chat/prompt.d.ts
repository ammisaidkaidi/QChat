/**
 * Prompt construction for the local chat agent.
 *
 * A 0.6B model is easily distracted, so the system prompt is explicit and
 * compact: scripts are declared in Qwen3's native `<tools>` shape (the format it
 * was trained on), the calling convention is shown with a concrete example, and
 * the model is told to prefer a script over answering from memory.
 */
import type { ModelStyle } from './modelStore.js';
import type { ProtocolMode } from './protocol.js';
import type { ScriptRecord } from '../scripts/types.js';
export declare const IDENTITY: string;
/** Collapse whitespace and cut at a word boundary, never mid-word. */
export declare function trimText(text: string, limit: number): string;
/** The function half of a tool declaration. */
interface FunctionSchema {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description?: string;
        }>;
        required?: string[];
    };
}
/** JSON-schema declaration for one script, in Qwen3's tool-call format. */
export declare function scriptFunctionSchema(record: ScriptRecord): FunctionSchema;
export declare function toolSchemas(records: readonly ScriptRecord[]): FunctionSchema[];
export declare const TOOL_PROTOCOL: string;
/**
 * The strict protocol, as the model reads it.
 *
 * One object per reply, and its `type` decides what the reply *is* — the only
 * wording that keeps "the model asked for a tool" and "a tool answered" apart
 * for a 0.6B model.
 */
export declare const ENVELOPE_SPEC: string[];
export interface SystemPromptOptions {
    records: readonly ScriptRecord[];
    tools: boolean;
    thinking: boolean;
    /** Prompting convention of the active model. Defaults to `qwen3`. */
    style?: ModelStyle;
    /**
     * Tool-call protocol. `strict-json` (the default) states the envelope
     * contract; `native` keeps the model's own trained shape; `legacy` is the
     * pre-protocol wording.
     */
    protocol?: ProtocolMode;
    identity?: string;
    /** Internet capabilities (webSearch/webFetch) are available. */
    net?: boolean;
    /** One line per skill, shown so the model knows what it can load. */
    skills?: string;
    /**
     * Characters the tool declarations may occupy. The engine sets this from the
     * model's context size; tools that do not fit are listed by name only.
     */
    toolBudget?: number;
    /**
     * The "way of thinking" the user picked (`models/systemPrompts.json`). It is
     * placed high on purpose: the small models otherwise drown it in tool listings.
     */
    styleGuide?: string;
    /** Tools exposed by connected MCP servers, with the schema each one declares. */
    mcp?: readonly {
        server: string;
        name: string;
        description: string;
        inputSchema?: Record<string, unknown>;
    }[];
}
export declare function buildSystemPrompt(options: SystemPromptOptions): string;
/** One-line-per-script summary, used by the CLI and the interface. */
export declare function toolboxListing(records: readonly ScriptRecord[]): string;
/**
 * Render a tool result compactly: the `{ok, result}` envelope is unwrapped so
 * the model sees the payload only, which both saves tokens and discourages it
 * from echoing JSON back to the user.
 */
export declare function formatToolResult(result: unknown): string;
/** Human-readable one-liner used when the model returns nothing usable. */
export declare function fallbackAnswer(toolName: string, result: unknown): string;
/**
 * Does the user ask about the toolbox itself ("which scripts do you have?")?
 *
 * Those questions are answerable only from the registry, but a 0.6B model often
 * replies from the tool listing in its own prompt instead of calling
 * `listScripts`, producing a vague answer. The engine uses this to nudge it once.
 */
export declare function asksAboutToolbox(text: string): boolean;
export declare function stripJsonBlobs(text: string): string;
/**
 * Instruction appended after tool results are supplied.
 *
 * The user's question is repeated *after* the payload on purpose: a small model
 * otherwise anchors on an earlier turn of the conversation.
 */
export declare function toolResultPrompt(results: readonly string[], userQuestion: string, options?: {
    envelope?: string;
}): string;
/**
 * Every function name the system prompt lists, in the order it lists them.
 *
 * The engine builds the JSON-schema grammar from this list, so the grammar and
 * the prompt can never disagree about which tools exist — `tests/chat.test.ts`
 * fails if they drift apart.
 */
export declare function toolboxNames(options: {
    records: readonly ScriptRecord[];
    net?: boolean;
    mcp?: readonly {
        server: string;
        name: string;
        description: string;
        inputSchema?: Record<string, unknown>;
    }[];
}): string[];
/**
 * The concrete strings inside a tool result: name fields, scalar values and
 * short strings. They are what a faithful answer is expected to mention.
 */
export declare function salientValues(result: unknown, limit?: number): string[];
/**
 * Did the model's reply actually use the tool result?
 *
 * A 0.6B model sometimes answers "I have several scripts available." even after
 * the registry handed it the names. When nothing from the payload appears in the
 * reply, the caller appends the factual line so the user is never left with a
 * vague sentence while the answer was right there.
 */
export declare function answerUsesResult(answer: string, result: unknown): boolean;
export {};
//# sourceMappingURL=prompt.d.ts.map
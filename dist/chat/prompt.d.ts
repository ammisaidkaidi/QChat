/**
 * Prompt construction for the local chat agent.
 *
 * A 0.6B model is easily distracted, so the system prompt is explicit and
 * compact: scripts are declared in Qwen3's native `<tools>` shape (the format it
 * was trained on), the calling convention is shown with a concrete example, and
 * the model is told to prefer a script over answering from memory.
 */
import type { ScriptRecord } from '../scripts/types.js';
export declare const IDENTITY: string;
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
export interface SystemPromptOptions {
    records: readonly ScriptRecord[];
    tools: boolean;
    thinking: boolean;
    identity?: string;
    /** Internet capabilities (webSearch/webFetch) are available. */
    net?: boolean;
    /** One line per skill, shown so the model knows what it can load. */
    skills?: string;
    /** Tools exposed by connected MCP servers. */
    mcp?: readonly {
        server: string;
        name: string;
        description: string;
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
export declare function toolResultPrompt(results: readonly string[], userQuestion: string): string;
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
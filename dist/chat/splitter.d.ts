/**
 * Incremental splitter for Qwen3 model output.
 *
 * While tokens stream in, three regions must be told apart so the interface can
 * render them differently:
 *
 *   plain text        → chat bubble content
 *   <think>…</think>  → collapsible reasoning block
 *   <tool_call>…</tool_call> → hidden here; parsed separately for execution
 *
 * Because a chunk boundary can fall in the middle of a tag (`<tool_` / `call>`),
 * a tail of the buffer is always held back until it is known not to start a tag.
 */
import type { ChatEvent } from './types.js';
export declare class OutputSplitter {
    private buffer;
    private mode;
    /** Swallow the blank lines Qwen3 leaves behind after a thinking block. */
    private trimLeading;
    /** Feed a raw chunk; returns the events it produced. */
    push(chunk: string): ChatEvent[];
    /** End of generation: emit whatever is still held back. */
    flush(): ChatEvent[];
}
/** Remove thinking blocks and stray tags from a finished reply. */
export declare function stripThinking(text: string): string;
//# sourceMappingURL=splitter.d.ts.map
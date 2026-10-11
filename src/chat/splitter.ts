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

const OPEN_THINK = '<think>';
const CLOSE_THINK = '</think>';
const OPEN_TOOL = '<tool_call>';
const CLOSE_TOOL = '</tool_call>';
const HOLD = Math.max(OPEN_TOOL.length, CLOSE_TOOL.length, OPEN_THINK.length, CLOSE_THINK.length);

type Mode = 'text' | 'thinking' | 'tool';

export class OutputSplitter {
  private buffer = '';
  private mode: Mode = 'text';
  /** Swallow the blank lines Qwen3 leaves behind after a thinking block. */
  private trimLeading = false;

  /** Feed a raw chunk; returns the events it produced. */
  public push(chunk: string): ChatEvent[] {
    this.buffer += chunk;
    const events: ChatEvent[] = [];

    for (;;) {
      if (this.trimLeading && this.mode === 'text') {
        this.buffer = this.buffer.replace(/^[ \t]*\n+/, '');
        if (this.buffer.trim().length > 0) this.trimLeading = false;
        else if (this.buffer.length === 0) return events;
      }

      const lower = this.buffer.toLowerCase();

      if (this.mode === 'text') {
        const openThink = lower.indexOf(OPEN_THINK);
        const openTool = lower.indexOf(OPEN_TOOL);
        const candidates = [openThink, openTool].filter((index) => index !== -1);
        const open = candidates.length > 0 ? Math.min(...candidates) : -1;

        if (open !== -1) {
          const before = this.buffer.slice(0, open);
          if (before) events.push({ type: 'token', text: before });
          this.buffer = this.buffer.slice(open);
          this.mode = this.buffer.toLowerCase().startsWith(OPEN_THINK) ? 'thinking' : 'tool';
          this.buffer = this.buffer.slice(
            this.buffer.toLowerCase().startsWith(OPEN_THINK) ? OPEN_THINK.length : OPEN_TOOL.length,
          );
          continue;
        }

        // Emit everything except a possible partial tag at the very end.
        const safeLength = Math.max(0, this.buffer.length - HOLD);
        const cut = this.buffer.lastIndexOf('<', this.buffer.length - 1);
        const emitLength = cut !== -1 && cut >= safeLength ? cut : safeLength;
        if (emitLength > 0) {
          events.push({ type: 'token', text: this.buffer.slice(0, emitLength) });
          this.buffer = this.buffer.slice(emitLength);
        }
        return events;
      }

      if (this.mode === 'thinking') {
        const close = lower.indexOf(CLOSE_THINK);
        if (close === -1) {
          const emitLength = Math.max(0, this.buffer.length - CLOSE_THINK.length);
          if (emitLength > 0) {
            events.push({ type: 'thinking', text: this.buffer.slice(0, emitLength) });
            this.buffer = this.buffer.slice(emitLength);
          }
          return events;
        }
        const thinking = this.buffer.slice(0, close);
        if (thinking) events.push({ type: 'thinking', text: thinking });
        this.buffer = this.buffer.slice(close + CLOSE_THINK.length);
        this.mode = 'text';
        this.trimLeading = true;
        continue;
      }

      // mode === 'tool': swallow the block, it is executed from the raw text.
      const close = lower.indexOf(CLOSE_TOOL);
      if (close === -1) return events;
      this.buffer = this.buffer.slice(close + CLOSE_TOOL.length);
      this.mode = 'text';
    }
  }

  /** End of generation: emit whatever is still held back. */
  public flush(): ChatEvent[] {
    const remaining = this.buffer;
    this.buffer = '';
    if (this.mode === 'thinking') {
      this.mode = 'text';
      return remaining ? [{ type: 'thinking', text: remaining.replace(/<\/think>/gi, '') }] : [];
    }
    if (this.mode === 'tool') {
      this.mode = 'text';
      return [];
    }
    return remaining ? [{ type: 'token', text: remaining }] : [];
  }
}

/** Remove thinking blocks and stray tags from a finished reply. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<\/think>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/^\s+/, '')
    .trim();
}

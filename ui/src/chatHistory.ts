interface HistoryToolCall {
  name: string;
  args: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  calls: HistoryToolCall[];
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_TOOL_HISTORY_CHARS = 5_000;
const MAX_TOOL_RESULT_CHARS = 900;

function compact(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Turns the full saved UI turns into the text history the local chat engine
 * consumes. Tool calls/results are included as a bounded, explicit transcript
 * on the assistant turn, so reopening a chat restores tool context too.
 */
export function chatHistoryFromTurns(turns: readonly HistoryTurn[]): HistoryMessage[] {
  return turns
    .filter((turn) => turn.text.trim().length > 0 && !turn.streaming)
    .map((turn) => {
      if (turn.role === 'user' || turn.calls.length === 0) {
        return { role: turn.role, content: turn.text };
      }

      let remaining = MAX_TOOL_HISTORY_CHARS;
      const rows: string[] = [];
      for (const call of turn.calls) {
        if (remaining <= 0) break;
        const args = compact(call.args, 400);
        const result = call.error
          ? `error: ${call.error}`
          : call.ok === false
            ? 'tool failed'
            : call.result === undefined
              ? 'no result recorded'
              : compact(call.result, MAX_TOOL_RESULT_CHARS);
        const row = `- ${call.name}(${args}) → ${result}`.slice(0, remaining);
        rows.push(row);
        remaining -= row.length + 1;
      }
      const toolHistory = rows.join('\n');
      const content = toolHistory
        ? `${turn.text}\n\n[Tools called in this earlier turn]\n${toolHistory}`
        : turn.text;
      return { role: 'assistant', content };
    });
}

/**
 * Prompt construction for the local chat agent.
 *
 * A 0.6B model is easily distracted, so the system prompt is explicit and
 * compact: scripts are declared in Qwen3's native `<tools>` shape (the format it
 * was trained on), the calling convention is shown with a concrete example, and
 * the model is told to prefer a script over answering from memory.
 */
import type { ScriptRecord } from '../scripts/types.js';

export const IDENTITY = [
  'You are InfAgent, a concise on-device assistant running fully offline (Qwen3-0.6B, CPU only).',
  'Answer in the user’s language and keep replies to one or two sentences.',
].join('\n');

interface FunctionSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** JSON-schema declaration for one script, in Qwen3's tool-call format. */
export function scriptFunctionSchema(record: ScriptRecord): FunctionSchema {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  for (const param of record.meta.params) {
    properties[param.name] = {
      type: param.type === 'any' ? 'string' : param.type,
      ...(param.description ? { description: param.description } : {}),
    };
    if (param.required) required.push(param.name);
  }

  return {
    name: record.meta.name,
    description: record.meta.description || `Run the ${record.meta.name} script.`,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

/** Tools the model may call to manage scripts while chatting. */
const MANAGEMENT_TOOLS: FunctionSchema[] = [
  {
    name: 'listScripts',
    description: 'List every agent script with its description and arguments.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'createScript',
    description: 'Create a new agent script (.js or .py) when no existing script fits the request.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase slug used as the file name.' },
        language: { type: 'string', description: 'js or py.' },
        description: { type: 'string', description: 'One line explaining what the script does.' },
      },
      required: ['name', 'language', 'description'],
    },
  },
];

export function toolSchemas(records: readonly ScriptRecord[]): FunctionSchema[] {
  return [...records.map(scriptFunctionSchema), ...MANAGEMENT_TOOLS];
}

export const TOOL_PROTOCOL = [
  'If a script’s purpose matches the request, call it instead of guessing.',
  'For general knowledge, chit-chat or anything no script covers, answer directly without calling a tool.',
  'To call a script, reply with exactly this and nothing else:',
  '<tool_call>',
  '{"name": "<script name>", "args": {"<argument>": <value>}}',
  '</tool_call>',
  'One <tool_call> block per call; several blocks in one reply are allowed.',
  'The tool result is then supplied to you: use it to answer the user in one short sentence, in plain language, without repeating the JSON.',
].join('\n');

export interface SystemPromptOptions {
  records: readonly ScriptRecord[];
  tools: boolean;
  thinking: boolean;
  identity?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const { records, tools, thinking, identity = IDENTITY } = options;
  const parts = [identity];

  if (!thinking) {
    // Qwen3 honours two soft switches: the token itself and an explicit
    // directive. Both are placed high so a long tool listing cannot bury them.
    parts.push('/no_think', 'Do not write a <think> block; answer immediately.');
  }

  if (tools) {
    parts.push(
      '',
      'You can call tools. Available tools:',
      '<tools>',
      JSON.stringify(toolSchemas(records)),
      '</tools>',
    );
    parts.push('', TOOL_PROTOCOL);
    if (records.length === 0) {
      parts.push('', 'No scripts are installed yet; offer to create one with createScript.');
    }
  } else {
    parts.push(
      '',
      'You have no tools: answer from your own knowledge and say when you are unsure.',
    );
  }

  return parts.join('\n');
}

/** One-line-per-script summary, used by the CLI and the interface. */
export function toolboxListing(records: readonly ScriptRecord[]): string {
  if (records.length === 0) return 'Agent scripts: none installed yet.';
  return [
    'Agent scripts:',
    ...records.map((record) => {
      const args = record.meta.params
        .map((param) => `${param.name}${param.required ? '' : '?'}:${param.type}`)
        .join(', ');
      return `- ${record.meta.name}(${args}) — ${record.meta.description || 'no description'}`;
    }),
  ].join('\n');
}

/**
 * Render a tool result compactly: the `{ok, result}` envelope is unwrapped so
 * the model sees the payload only, which both saves tokens and discourages it
 * from echoing JSON back to the user.
 */
export function formatToolResult(result: unknown): string {
  let value = result;

  if (typeof value === 'object' && value !== null && 'ok' in value) {
    const envelope = value as { ok: boolean; result?: unknown; error?: unknown };
    value = envelope.ok ? envelope.result : { error: envelope.error ?? 'failed' };
  }

  const text = flatten(value);
  return text.length > 600 ? `${text.slice(0, 600)}… (truncated)` : text;
}

/** Render nested values as `key: value` lines instead of raw JSON braces. */
function flatten(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value !== 'object') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.map((item) => `${'  '.repeat(depth)}- ${flatten(item, depth + 1)}`).join('\n');
  }

  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      if (item !== null && typeof item === 'object')
        return `${'  '.repeat(depth)}${key}:\n${flatten(item, depth + 1)}`;
      return `${'  '.repeat(depth)}${key}: ${String(item)}`;
    })
    .join('\n');
}

/** Human-readable one-liner used when the model returns nothing usable. */
export function fallbackAnswer(toolName: string, result: unknown): string {
  let value = result;
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    const envelope = value as { ok: boolean; result?: unknown; error?: unknown };
    value = envelope.ok ? envelope.result : { error: envelope.error ?? 'failed' };
  }
  // A list of named records reads best as "name — description" pairs.
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'object' && item !== null)
  ) {
    const items = value
      .slice(0, 6)
      .map((item) => {
        const record = item as Record<string, unknown>;
        const name = typeof record['name'] === 'string' ? record['name'] : undefined;
        const description =
          typeof record['description'] === 'string' ? record['description'] : undefined;
        if (!name) return flatten(item).split('\n').filter(Boolean).join(' · ');
        return description ? `${name} — ${description}` : name;
      })
      .filter(Boolean);
    if (items.length > 0) return `${toolName}: ${items.join('; ')}`;
  }

  const flat = flatten(value).split('\n').filter(Boolean).slice(0, 4).join(' · ');
  return `${toolName} → ${flat || 'done'}`;
}

/** Drop JSON blobs a small model may echo back instead of paraphrasing. */
export function stripJsonBlobs(text: string): string {
  return text
    .replace(/\{[^{}]*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;!?])/g, '$1')
    .trim();
}

/**
 * Instruction appended after tool results are supplied.
 *
 * The user's question is repeated *after* the payload on purpose: a small model
 * otherwise anchors on an earlier turn of the conversation.
 */
export function toolResultPrompt(results: readonly string[], userQuestion: string): string {
  return [
    'Tool output:',
    ...results,
    '',
    `User question: ${userQuestion}`,
    '',
    'Using only the tool output above, answer that user question in one short sentence of plain language.',
    'Do not repeat the JSON, do not describe the tool call, and do not emit another <tool_call> block.',
  ].join('\n');
}

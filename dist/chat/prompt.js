export const IDENTITY = [
    'You are InfAgent, a concise on-device assistant running fully offline (Qwen3-0.6B, CPU only).',
    'Answer in the user’s language and keep replies to one or two sentences.',
].join('\n');
/**
 * Qwen3 was trained on OpenAI-style tool objects, and its chat template dumps
 * one per line inside `<tools>`. A bare function object (without the
 * `type`/`function` wrapper) measurably degrades tool calling on 0.6B.
 */
function asNativeTool(schema) {
    return { type: 'function', function: schema };
}
/** JSON-schema declaration for one script, in Qwen3's tool-call format. */
export function scriptFunctionSchema(record) {
    const properties = {};
    const required = [];
    for (const param of record.meta.params) {
        properties[param.name] = {
            type: param.type === 'any' ? 'string' : param.type,
            ...(param.description ? { description: param.description } : {}),
        };
        if (param.required)
            required.push(param.name);
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
const MANAGEMENT_TOOLS = [
    {
        name: 'listScripts',
        description: 'List every agent script with its description and arguments. Call this ' +
            'whenever the user asks which scripts exist, what you can do, or which tools you have.',
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
export function toolSchemas(records) {
    return [...records.map(scriptFunctionSchema), ...MANAGEMENT_TOOLS];
}
export const TOOL_PROTOCOL = [
    'If a function matches the request, call it instead of guessing from memory.',
    'Never answer a question about the available scripts, tools or your own capabilities from this listing: call listScripts and use its output.',
    'For general knowledge, chit-chat, or anything no function covers, answer directly without calling one.',
    'Emit the <tool_call> block alone, with no prose around it.',
    'A tool result is then supplied to you: answer the user in one short sentence of plain language, without repeating the JSON.',
].join('\n');
export function buildSystemPrompt(options) {
    const { records, tools, thinking, identity = IDENTITY } = options;
    const parts = [identity];
    if (!thinking) {
        // Qwen3 honours two soft switches: the token itself and an explicit
        // directive. Both are placed high so a long tool listing cannot bury them.
        parts.push('/no_think', 'Do not write a <think> block; answer immediately.');
    }
    if (tools) {
        // Verbatim Qwen3 preamble: the model was fine-tuned on this exact wording,
        // line layout (`<tools>` holds one JSON object per line, not an array) and
        // `arguments` key, so it must not be "improved".
        parts.push('', '# Tools', '', 'You may call one or more functions to assist with the user query.', '', 'You are provided with function signatures within <tools></tools> XML tags:', '<tools>', ...toolSchemas(records).map((schema) => JSON.stringify(asNativeTool(schema))), '</tools>', '', 'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:', '<tool_call>', '{"name": <function-name>, "arguments": <args-json-object>}', '</tool_call>');
        parts.push('', TOOL_PROTOCOL);
        if (records.length === 0) {
            parts.push('', 'No scripts are installed yet; offer to create one with createScript.');
        }
    }
    else {
        parts.push('', 'You have no tools: answer from your own knowledge and say when you are unsure.');
    }
    return parts.join('\n');
}
/** One-line-per-script summary, used by the CLI and the interface. */
export function toolboxListing(records) {
    if (records.length === 0)
        return 'Agent scripts: none installed yet.';
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
export function formatToolResult(result) {
    let value = result;
    if (typeof value === 'object' && value !== null && 'ok' in value) {
        const envelope = value;
        value = envelope.ok ? envelope.result : { error: envelope.error ?? 'failed' };
    }
    const text = flatten(value);
    return text.length > 600 ? `${text.slice(0, 600)}… (truncated)` : text;
}
/** Render nested values as `key: value` lines instead of raw JSON braces. */
function flatten(value, depth = 0) {
    if (value === null || value === undefined)
        return 'none';
    if (typeof value !== 'object')
        return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0)
            return 'none';
        return value.map((item) => `${'  '.repeat(depth)}- ${flatten(item, depth + 1)}`).join('\n');
    }
    return Object.entries(value)
        .map(([key, item]) => {
        if (item !== null && typeof item === 'object')
            return `${'  '.repeat(depth)}${key}:\n${flatten(item, depth + 1)}`;
        return `${'  '.repeat(depth)}${key}: ${String(item)}`;
    })
        .join('\n');
}
/** Human-readable one-liner used when the model returns nothing usable. */
export function fallbackAnswer(toolName, result) {
    let value = result;
    if (typeof value === 'object' && value !== null && 'ok' in value) {
        const envelope = value;
        value = envelope.ok ? envelope.result : { error: envelope.error ?? 'failed' };
    }
    // A list of named records reads best as "name — description" pairs.
    if (Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'object' && item !== null)) {
        const items = value
            .slice(0, 6)
            .map((item) => {
            const record = item;
            const name = typeof record['name'] === 'string' ? record['name'] : undefined;
            const description = typeof record['description'] === 'string' ? record['description'] : undefined;
            if (!name)
                return flatten(item).split('\n').filter(Boolean).join(' · ');
            return description ? `${name} — ${description}` : name;
        })
            .filter(Boolean);
        if (items.length > 0)
            return `${toolName}: ${items.join('; ')}`;
    }
    const flat = flatten(value).split('\n').filter(Boolean).slice(0, 4).join(' · ');
    return `${toolName} → ${flat || 'done'}`;
}
/**
 * Does the user ask about the toolbox itself ("which scripts do you have?")?
 *
 * Those questions are answerable only from the registry, but a 0.6B model often
 * replies from the tool listing in its own prompt instead of calling
 * `listScripts`, producing a vague answer. The engine uses this to nudge it once.
 */
export function asksAboutToolbox(text) {
    const question = text.toLowerCase();
    const noun = '(scripts?|tools?|functions?|callbacks?)';
    return [
        new RegExp(`\\b(which|what|how many|list|show|tell me|name)\\b(?:\\s+\\w+){0,2}\\s+${noun}\\b`),
        new RegExp(`\\bany\\s+${noun}\\b`),
        new RegExp(`\\b${noun}\\s+(are|is)\\s+(available|installed|there|defined)\\b`),
        /\bwhat can you do\b/,
        /\byour\s+(capabilit\w*|tools|scripts)\b/,
    ].some((pattern) => pattern.test(question));
}
export function stripJsonBlobs(text) {
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
export function toolResultPrompt(results, userQuestion) {
    // Qwen3 expects tool output inside a user turn as <tool_response> blocks.
    // The question is repeated *after* the payload so a small model does not
    // anchor on an earlier turn of the conversation.
    return [
        ...results.map((result) => `<tool_response>\n${result}\n</tool_response>`),
        '',
        `User question: ${userQuestion}`,
        '',
        'Using only the tool output above, answer that user question in one short sentence of plain language.',
        'Do not repeat the JSON, do not describe the tool call, and do not emit another <tool_call> block.',
    ].join('\n');
}
/** Unwrap the `{ok, result}` envelope a script run returns. */
function unwrapEnvelope(result) {
    if (typeof result === 'object' && result !== null && 'ok' in result) {
        const envelope = result;
        return envelope.ok ? envelope.result : { error: envelope.error ?? 'failed' };
    }
    return result;
}
/**
 * The concrete strings inside a tool result: name fields, scalar values and
 * short strings. They are what a faithful answer is expected to mention.
 */
export function salientValues(result, limit = 12) {
    const found = [];
    const walk = (value) => {
        if (found.length >= limit)
            return;
        if (typeof value === 'string') {
            if (value.length >= 3 && value.length <= 60)
                found.push(value);
            return;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            found.push(String(value));
            return;
        }
        if (typeof value !== 'object' || value === null)
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                walk(item);
            return;
        }
        for (const item of Object.values(value))
            walk(item);
    };
    walk(unwrapEnvelope(result));
    return [...new Set(found)];
}
/**
 * Did the model's reply actually use the tool result?
 *
 * A 0.6B model sometimes answers "I have several scripts available." even after
 * the registry handed it the names. When nothing from the payload appears in the
 * reply, the caller appends the factual line so the user is never left with a
 * vague sentence while the answer was right there.
 */
export function answerUsesResult(answer, result) {
    const values = salientValues(result).filter((value) => Number.isNaN(Number(value)));
    if (values.length === 0)
        return true;
    const lower = answer.toLowerCase();
    return values.some((value) => lower.includes(value.toLowerCase()));
}
//# sourceMappingURL=prompt.js.map
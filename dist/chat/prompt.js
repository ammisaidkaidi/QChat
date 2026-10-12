export const IDENTITY = [
    'You are InfAgent, a concise on-device assistant running fully offline (llama.cpp, CPU only).',
    'Answer in the user’s language and keep replies to one or two sentences.',
].join('\n');
/**
 * A tool declaration is a fixed cost paid on every single turn, so descriptions
 * are trimmed to what the model needs to choose the tool. With four MCP servers
 * connected the untrimmed block was ~11 KB (≈3 200 tokens) — more than the whole
 * context window of the small default model.
 */
const TOOL_DESCRIPTION_LIMIT = 110;
const PARAM_DESCRIPTION_LIMIT = 60;
/** Characters of tool declarations the prompt may spend. Set by the engine. */
const DEFAULT_TOOL_BUDGET = 5000;
/** Collapse whitespace and cut at a word boundary, never mid-word. */
export function trimText(text, limit) {
    const flat = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (flat.length <= limit)
        return flat;
    const head = flat.slice(0, limit);
    const cut = head.lastIndexOf(' ');
    const body = (cut > limit * 0.6 ? head.slice(0, cut) : head).replace(/[.,;:]$/, '');
    return `${body}…`;
}
/**
 * Qwen3 was trained on OpenAI-style tool objects, and its chat template dumps
 * one per line inside `<tools>`. A bare function object (without the
 * `type`/`function` wrapper) measurably degrades tool calling on 0.6B.
 */
function asNativeTool(schema) {
    return { type: 'function', function: schema };
}
/** A declaration with every description trimmed to its budget. */
function trimmed(schema) {
    const properties = {};
    for (const [name, value] of Object.entries(schema.parameters.properties)) {
        const short = value.description ? trimText(value.description, PARAM_DESCRIPTION_LIMIT) : '';
        properties[name] = { type: value.type, ...(short ? { description: short } : {}) };
    }
    return {
        name: schema.name,
        description: trimText(schema.description, TOOL_DESCRIPTION_LIMIT),
        parameters: {
            type: 'object',
            properties,
            ...(schema.parameters.required ? { required: schema.parameters.required } : {}),
        },
    };
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
    'A tool result is then supplied to you: answer the user in one short sentence of plain language, without repeating the JSON.',
].join('\n');
/**
 * The call convention, per model style.
 *
 * Qwen3 was fine-tuned on the `<tool_call>` wording, and the Hammer2.1 / xLAM
 * family on a bare JSON array (`[...]`, "NO other text MUST be included"), so
 * each one gets the shape it was trained on rather than a compromise.
 */
const CALL_FORMAT = {
    qwen3: [
        'For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:',
        '<tool_call>',
        '{"name": <function-name>, "arguments": <args-json-object>}',
        '</tool_call>',
        'Emit the <tool_call> block alone, with no prose around it.',
    ],
    xlam: [
        'To call one or more functions, reply with a single JSON array and nothing else — no prose, no code fence:',
        '[{"name": <function-name>, "arguments": <args-json-object>}, …]',
        'If no function is needed, answer the user in plain text instead.',
    ],
    // The ChatML/Hermes convention: what most non-Qwen3 small models were trained
    // on, and what the parser reads most robustly.
    plain: [
        'To call a function, reply with a JSON object inside <tool_call></tool_call> tags, on its own, with no other text:',
        '<tool_call>',
        '{"name": <function-name>, "arguments": <args-json-object>}',
        '</tool_call>',
    ],
};
/** The internet tools, offered only when internet access is on. */
const NET_TOOLS = [
    {
        name: 'webSearch',
        description: 'Search the internet and return titles, URLs and snippets. Call this for ' +
            'current facts, news, prices or anything newer than your training data.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search keywords.' },
                limit: { type: 'number', description: 'How many results, 1-10 (default 5).' },
            },
            required: ['query'],
        },
    },
    {
        name: 'webFetch',
        description: 'Fetch one http(s) page and return its readable text. Use it after webSearch ' +
            'to read a result properly.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Absolute http(s) URL.' },
                maxChars: { type: 'number', description: 'Character cap (default 4000).' },
            },
            required: ['url'],
        },
    },
];
/** Tools that are always available with the toolbox: alerts and the skills. */
const ALWAYS_ON_TOOLS = [
    {
        name: 'showAlert',
        description: 'Show an alert in the InfAgent interface so the user cannot miss it. Call ' +
            'this whenever the user asks to be alerted, notified, warned, or asks for ' +
            'an alert, popup, message box or reminder.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The text shown to the user.' },
                title: { type: 'string', description: 'Short heading (optional).' },
                level: { type: 'string', description: 'info, success, warning or error (default info).' },
            },
            required: ['message'],
        },
    },
    {
        name: 'listSkills',
        description: 'List the available skills (procedures) with their descriptions.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'readSkill',
        description: 'Read the full instructions of one skill before following it.',
        parameters: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Skill name.' } },
            required: ['name'],
        },
    },
    {
        name: 'createSkill',
        description: 'Save a new reusable procedure as a skill after solving a task.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Lowercase slug.' },
                description: { type: 'string', description: 'One line describing the skill.' },
                when: { type: 'string', description: 'When to use it.' },
                body: { type: 'string', description: 'Markdown steps.' },
            },
            required: ['name', 'description'],
        },
    },
];
/** Tool declaration for one MCP tool, namespaced `server__tool`. */
function mcpFunctionSchema(server, tool) {
    const schema = (tool.inputSchema ?? {});
    const properties = {};
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
        const type = typeof value?.type === 'string' ? value.type : 'string';
        const description = typeof value?.description === 'string' && value.description.length > 0
            ? trimText(value.description, PARAM_DESCRIPTION_LIMIT)
            : undefined;
        properties[name] = { type, ...(description ? { description } : {}) };
    }
    const required = Array.isArray(schema.required)
        ? schema.required.filter((entry) => typeof entry === 'string')
        : [];
    return {
        name: `${server}__${tool.name}`,
        description: `[MCP: ${server}] ${trimText(tool.description || tool.name, TOOL_DESCRIPTION_LIMIT)}`,
        parameters: {
            type: 'object',
            properties,
            ...(required.length > 0 ? { required } : {}),
        },
    };
}
export function buildSystemPrompt(options) {
    const { records, tools, thinking, style = 'qwen3', identity = IDENTITY, net = false, skills, mcp = [], styleGuide, } = options;
    const parts = [identity];
    if (styleGuide?.trim()) {
        // One template, one heading, no preamble: a 0.6B model copies the last
        // instruction it read, so the selected style stays short and imperative.
        parts.push('', '# Working style', styleGuide.trim());
    }
    if (style === 'qwen3' && !thinking) {
        // Qwen3 honours two soft switches: the token itself and an explicit
        // directive. Both are placed high so a long tool listing cannot bury them.
        // Other families (Hammer2.1, xLAM) have no such switch — sending /no_think
        // to them would only add noise to the prompt.
        parts.push('/no_think', 'Do not write a <think> block; answer immediately.');
    }
    if (tools) {
        // Nothing is declared twice: an MCP server may re-expose a script that is
        // already in the toolbox.
        const seen = new Set();
        const wanted = [
            ...toolSchemas(records),
            ...ALWAYS_ON_TOOLS,
            ...(net ? NET_TOOLS : []),
            ...mcp.map((tool) => mcpFunctionSchema(tool.server, tool)),
        ].filter((schema) => {
            if (seen.has(schema.name))
                return false;
            seen.add(schema.name);
            return true;
        });
        // Spend the budget in priority order (the agent's own tools first, then the
        // MCP servers) and keep the overflow as bare names: the model may still call
        // a tool it only knows the name of, it just does not get a description.
        const budget = options.toolBudget ?? DEFAULT_TOOL_BUDGET;
        const signatures = [];
        const overflow = [];
        let spent = 0;
        for (const schema of wanted) {
            const line = JSON.stringify(asNativeTool(trimmed(schema)));
            if (signatures.length === 0 || spent + line.length <= budget) {
                signatures.push(line);
                spent += line.length;
            }
            else {
                overflow.push(schema.name);
            }
        }
        parts.push('', '# Tools', '', 'You may call one or more functions to assist with the user query.', '');
        if (style === 'qwen3' || style === 'plain') {
            // Verbatim Qwen3 preamble: the model was tuned on this exact wording, line
            // layout (`<tools>` holds one JSON object per line, not an array) and
            // `arguments` key — and the ChatML/Hermes family expects the same block.
            parts.push('You are provided with function signatures within <tools></tools> XML tags:', '<tools>', ...signatures, '</tools>');
        }
        else {
            // Hammer2.1 lists its functions between these two markers; xLAM-2 reads
            // the same JSON dump from its system turn.
            parts.push('You are provided with function signatures within ' +
                '[BEGIN OF AVAILABLE_TOOLS] and [END OF AVAILABLE_TOOLS] markers:', '[BEGIN OF AVAILABLE_TOOLS]', ...signatures, '[END OF AVAILABLE_TOOLS]');
        }
        if (overflow.length > 0) {
            parts.push('', 'These tools exist too — call them the same way, with the arguments their name implies:', overflow.join(', '));
        }
        parts.push('', ...CALL_FORMAT[style]);
        parts.push('', TOOL_PROTOCOL);
        if (net) {
            parts.push('', 'webSearch and webFetch reach the internet; use them instead of guessing about current events.');
        }
        parts.push('', 'showAlert puts a message in front of the user; use it when they ask to be alerted.');
        if (skills)
            parts.push('', '# Skills', skills, 'Call readSkill before following a skill.');
        if (mcp.length > 0) {
            parts.push('', `MCP tools are prefixed with their server (${[...new Set(mcp.map((tool) => tool.server))].join(', ')}).`);
        }
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
    // A question is only about *this* agent's toolbox when it points at the agent
    // or at availability: "which scripts do you have" yes, "what is a function
    // call" no. Forcing listScripts for a definition made small models answer
    // general knowledge with a script listing.
    const directed = /\b(your|you|me|my|available|installed|defined|can you)\b/.test(question);
    const asksWhich = new RegExp(`\\b(which|how many|list|show|name|tell me)\\b(?:\\s+\\w+){0,3}\\s+${noun}\\b`).test(question);
    const availability = new RegExp(`\\b${noun}\\s+(are|is)\\s+(available|installed|there|defined)\\b`).test(question);
    // "do you have any scripts installed?"
    const hasAny = new RegExp(`\\b(any|some)\\s+${noun}\\b`).test(question);
    return (((asksWhich || availability || hasAny) && directed) ||
        /\bwhat can you do\b/.test(question) ||
        /\byour\s+(capabilit\w*|tools|scripts)\b/.test(question));
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
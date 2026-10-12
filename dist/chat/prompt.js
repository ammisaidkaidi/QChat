import { FINAL_EXAMPLE, RESULT_RULE, TOOL_CALL_EXAMPLE } from './protocol.js';
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
/**
 * The strict protocol, as the model reads it.
 *
 * One object per reply, and its `type` decides what the reply *is* — the only
 * wording that keeps "the model asked for a tool" and "a tool answered" apart
 * for a 0.6B model.
 */
export const ENVELOPE_SPEC = [
    'Reply with exactly one JSON object and nothing else — no prose, no code fence, no second object.',
    '',
    'To call one or more functions, use the "tool_call" object:',
    TOOL_CALL_EXAMPLE,
    '',
    'To answer the user, use the "final" object and put the whole answer in "content":',
    FINAL_EXAMPLE,
    '',
    'Use only the function names listed above, spelled exactly, and give every argument the function expects.',
    RESULT_RULE,
];
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
        parts.push('', ...(options.protocol === 'strict-json' ? ENVELOPE_SPEC : CALL_FORMAT[style]));
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
        // A failed call is reported as a failure — never as an empty list.
        if (envelope.ok === false) {
            return `${toolName} → failed: ${trimText(String(envelope.error ?? 'failed'), 160)}`;
        }
        value = envelope.result;
    }
    // The authoritative empty: say so in the tool's own vocabulary.
    if (resultIsEmpty(value))
        return `${toolName} → no ${listNoun(toolName)} found.`;
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
    const asksWhich = new RegExp(`\\b(which|what|how many|list|show|name|tell me)\\b(?:\\s+\\w+){0,3}\\s+${noun}\\b`).test(question);
    const availability = new RegExp(`\\b${noun}\\s+(are|is)\\s+(available|installed|there|defined)\\b`).test(question);
    // "do you have any scripts installed?"
    const hasAny = new RegExp(`\\b(any|some)\\s+${noun}\\b`).test(question);
    // A bare command — the user typing the tool name itself ("listscripts",
    // "list scripts", "list_scripts", "ls scripts"). It must never be answered
    // with "there are no scripts": the registry knows, so the engine asks it.
    const bare = question.replace(/[?!.,\s]+$/u, '').trim();
    const bareCommand = /^(ls|list)[\s_-]*(all[\s_-]*)?(my[\s_-]*)?scripts?$/.test(bare);
    return (bareCommand ||
        ((asksWhich || availability || hasAny) && directed) ||
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
export function toolResultPrompt(results, userQuestion, options = {}) {
    // The question is repeated *after* the payload so a small model does not
    // anchor on an earlier turn of the conversation.
    const envelope = options.envelope;
    return [
        // Under the strict protocol the payload is a machine object the model can
        // tell apart from its own call; otherwise it is Qwen3's <tool_response>.
        ...(envelope ? [envelope, '', 'What the tool returned (readable copy):'] : []),
        ...(envelope
            ? results.map((result) => `- ${result}`)
            : results.map((result) => `<tool_response>\n${result}\n</tool_response>`)),
        '',
        `User question: ${userQuestion}`,
        '',
        envelope
            ? [
                'Answer that question from the tool output above.',
                'If it listed items, name them; if it listed none, say that it is empty.',
                'Never say a tool returned nothing — and never say it failed — unless the output above says so.',
                'Do not repeat the tool JSON and do not call a tool again: reply with the "final" object.',
            ].join('\n')
            : 'Using only the tool output above, answer that user question in one short sentence of plain language.',
        envelope
            ? ''
            : 'Do not repeat the JSON, do not describe the tool call, and do not emit another <tool_call> block.',
    ]
        .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
        .join('\n');
}
/**
 * Every function name the system prompt lists, in the order it lists them.
 *
 * The engine builds the JSON-schema grammar from this list, so the grammar and
 * the prompt can never disagree about which tools exist — `tests/chat.test.ts`
 * fails if they drift apart.
 */
export function toolboxNames(options) {
    const seen = new Set();
    const names = [
        ...toolSchemas(options.records),
        ...ALWAYS_ON_TOOLS,
        ...(options.net ? NET_TOOLS : []),
        ...(options.mcp ?? []).map((tool) => mcpFunctionSchema(tool.server, tool)),
    ].filter((schema) => {
        if (seen.has(schema.name))
            return false;
        seen.add(schema.name);
        return true;
    });
    return names.map((schema) => schema.name);
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
 * Is this result an *authoritative* empty?
 *
 * Only then may anything say "there are none": an empty list, an empty object,
 * an empty string or nothing at all. A failed call is never empty — see
 * `guardToolAnswer`, which reports the failure instead.
 */
export function resultIsEmpty(result) {
    const value = unwrapEnvelope(result);
    if (value === null || value === undefined)
        return true;
    if (typeof value === 'string')
        return value.trim().length === 0;
    if (Array.isArray(value))
        return value.length === 0;
    if (typeof value === 'object')
        return Object.keys(value).length === 0;
    return false;
}
/** `listScripts` → `scripts`, `list_files` → `files`: a noun for an empty list. */
function listNoun(toolName) {
    const stripped = toolName.replace(/^(list|search|find|get)[_\s-]*/i, '').trim();
    return stripped.length >= 3 ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : 'items';
}
/**
 * The values that identify the payload's items: the `name` (or `title`, `id`, …)
 * of every record in a list.
 *
 * These — and not the parameter names a listing also carries — are what a
 * faithful answer has to mention. Matching on `name`/`path`/`limit` instead made
 * "you need to specify a name" look like an answer that used the result, which
 * is exactly how a wrong "there are no scripts" survived the factual fallback.
 */
const IDENTIFIER_KEYS = ['name', 'title', 'id', 'key', 'label', 'tool', 'script', 'file', 'path'];
export function identifyingValues(result, limit = 12) {
    const value = unwrapEnvelope(result);
    const found = [];
    const take = (item) => {
        if (typeof item !== 'object' || item === null)
            return;
        const record = item;
        for (const key of IDENTIFIER_KEYS) {
            const candidate = record[key];
            if (typeof candidate === 'string' && candidate.trim().length >= 2) {
                found.push(candidate.trim());
                return;
            }
        }
    };
    if (Array.isArray(value)) {
        for (const item of value) {
            if (found.length >= limit)
                break;
            take(item);
        }
    }
    else {
        take(value);
    }
    return [...new Set(found)];
}
/**
 * Words that carry no evidence: the parameter names of the toolbox itself and
 * structural JSON words. An answer that only repeats them has not read anything.
 */
const NON_EVIDENCE = new Set([
    'args',
    'argument',
    'arguments',
    'error',
    'false',
    'id',
    'input',
    'language',
    'name',
    'none',
    'ok',
    'parameters',
    'path',
    'result',
    'true',
    'type',
    'value',
]);
/** Does the reply say nothing is there, while the tool said otherwise? */
export function answerClaimsEmpty(answer) {
    const text = answer.toLowerCase();
    return (/\b(no|zero|0)\s+(scripts?|tools?|files?|results?|items?|records?|matches|entries|rows?|data)\b/.test(text) ||
        /\bthere (are|is) (no|not any|none)\b/.test(text) ||
        /\b(nothing|none)\s+(was|were|is|are|found|available|registered|returned)\b/.test(text) ||
        /\b(empty|no results?|came back empty)\b/.test(text) ||
        /\b(did not|didn't|could not|couldn't)\s+(find|return|list)\b/.test(text));
}
/** The error text of a failed outcome, or `null` when the call succeeded. */
export function outcomeError(outcome) {
    if (outcome.ok)
        return null;
    const text = String(outcome.error ?? '').trim();
    if (text)
        return text;
    const value = outcome.result;
    return typeof value === 'string' && value.trim() ? value.trim() : 'failed';
}
/**
 * Does the reply state a count that the payload contradicts?
 *
 * "You have three scripts." over a six-script list is not a summary of the
 * payload, it is a different claim about it — the same class of error as
 * "there are none", one number later. Only an explicit count is judged here;
 * prose that mentions no number is left to the model.
 */
const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
};
/** The number the reply states about a list ("three scripts"), if it states one. */
export function statedCount(answer) {
    const match = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(scripts?|tools?|files?|items?|results?|records?|entries|rows?|matches)\b/.exec(answer.toLowerCase());
    if (!match)
        return null;
    const value = NUMBER_WORDS[match[1] ?? ''] ?? Number(match[1]);
    return Number.isFinite(value) ? value : null;
}
export function answerStatesWrongCount(answer, count) {
    const stated = statedCount(answer);
    return stated !== null && stated !== count;
}
/**
 * Does the reply present itself as *the* list ("the scripts are …", "you
 * have …")? A sentence like that claims completeness, so naming three of six
 * scripts is as wrong as saying there are none.
 */
export function answerEnumerates(answer) {
    return /\b(scripts?|tools?|files?|items?|results?|skills?|functions?)\b\s*(:|\bare\b|\bis\b)|\byou have\b/i.test(answer);
}
/** Does the reply mention the failure at all? */
export function answerMentionsError(answer, error) {
    const text = answer.toLowerCase();
    const target = error.toLowerCase();
    if (target.length >= 4 && text.includes(target))
        return true;
    return /\b(error|failed|failure|could not|couldn't|refused|denied|unavailable|not supported)\b/.test(text);
}
/** What the model should be told after a tool ran: the facts, one readable line. */
export function readableResult(result, limit = 8) {
    const value = unwrapEnvelope(result);
    if (Array.isArray(value) && value.length > 0) {
        const pairs = value
            .slice(0, limit)
            .map((item) => {
            if (typeof item !== 'object' || item === null)
                return String(item);
            const record = item;
            const name = identifyingValues([item])[0] ?? flatten(item).split('\n')[0] ?? '';
            const description = typeof record['description'] === 'string' ? record['description'].trim() : '';
            return description ? `${name} — ${description}` : name;
        })
            .filter(Boolean);
        if (pairs.length > 0)
            return pairs.join('; ');
    }
    const flat = flatten(value).split('\n').filter(Boolean).slice(0, 6).join('; ');
    return flat;
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
    const lower = answer.toLowerCase();
    // A list of records is judged on the values that identify its items.
    const identifiers = identifyingValues(result);
    if (identifiers.length > 0) {
        return identifiers.some((value) => lower.includes(value.toLowerCase()));
    }
    const values = salientValues(result).filter((value) => Number.isNaN(Number(value)) && !NON_EVIDENCE.has(value.toLowerCase().trim()));
    if (values.length === 0)
        return true;
    return values.some((value) => lower.includes(value.toLowerCase()));
}
/**
 * Hold the reply against the tool result that produced it.
 *
 * The model is free to phrase the answer, but it is not free to contradict the
 * payload: an empty claim over a non-empty list, or a silent failure, is
 * corrected by the runtime, which is the only authority on what a tool returned.
 */
export function guardToolAnswer(answer, outcome) {
    if (!outcome)
        return { kind: 'none' };
    const text = answer.trim();
    const facts = fallbackAnswer(outcome.name, {
        ok: outcome.ok,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    // A failure is never an empty result: say what went wrong, in any case.
    if (!outcome.ok) {
        const error = outcomeError(outcome);
        if (text.length === 0)
            return { kind: 'replace', text: facts };
        // "you have no scripts" over a failed call is false in the same way: replace.
        if (answerClaimsEmpty(text))
            return { kind: 'replace', text: facts };
        if (error && !answerMentionsError(text, error))
            return { kind: 'append', text: facts };
        return { kind: 'none' };
    }
    // An empty payload: the only truthful answer is that there is nothing.
    if (resultIsEmpty(outcome.result)) {
        if (text.length === 0)
            return { kind: 'replace', text: facts };
        // The model may have phrased the emptiness differently; do not contradict it.
        return { kind: 'none' };
    }
    // Non-empty payload: a reply that says there is nothing is false.
    if (answerClaimsEmpty(text))
        return { kind: 'replace', text: facts };
    // A list of named items the reply counts wrongly ("three scripts" over six)
    // is as misleading as one it denies entirely.
    const items = identifyingValues(outcome.result);
    const stated = statedCount(text);
    if (items.length > 1 && stated !== null && stated !== items.length) {
        return { kind: 'replace', text: facts };
    }
    // A small list of named items: an enumerating sentence that names some of
    // them and stops is incomplete, exactly like a wrong count.
    if (items.length > 1 && items.length <= 8 && answerEnumerates(text)) {
        const named = items.filter((name) => text.toLowerCase().includes(name.toLowerCase())).length;
        if (named > 0 && named < items.length)
            return { kind: 'replace', text: facts };
    }
    // Nothing usable came back (an empty reply, or the echoed JSON that
    // `stripJsonBlobs` already removed): the facts stand on their own.
    if (text.length === 0)
        return { kind: 'append', text: facts };
    // The right count is a use of the payload even when no name is repeated.
    if (stated !== null && stated === items.length)
        return { kind: 'none' };
    // A reply that ignored the payload entirely gets the facts underneath it.
    if (!answerUsesResult(text, outcome.result))
        return { kind: 'append', text: facts };
    return { kind: 'none' };
}
//# sourceMappingURL=prompt.js.map
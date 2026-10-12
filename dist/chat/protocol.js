/**
 * The strict JSON tool protocol.
 *
 * A reply is exactly one JSON object, and its `type` says what it is:
 *
 *   {"type":"tool_call","calls":[{"name":"listScripts","arguments":{}}]}
 *   {"type":"final","content":"You have three scripts: …"}
 *
 * The runtime answers with a third object — `tool_result` — which the model may
 * never write, so "the model called a tool" and "a tool returned this" can never
 * be confused for one another.
 *
 * Three things keep the format honest, in this order:
 *
 *   1. `envelopeGrammarSchema()` turns the protocol into a llama.cpp JSON-schema
 *      grammar: a malformed reply is not unlikely but unrepresentable, tool
 *      names are limited to the toolbox that was actually offered, and
 *      `content` stays a free string so the answer itself is not boxed in.
 *   2. The system prompt states the same contract (`ENVELOPE_SPEC` in
 *      `prompt.ts`), because a grammar the model does not expect costs quality.
 *   3. `parseEnvelope()` checks the reply anyway and returns a precise reason;
 *      the engine turns that reason into one correction turn, and only then
 *      falls back to the lenient parser.
 */
import process from 'node:process';
/** How many correction turns a reply that did not parse is worth. */
export const MAX_REPAIRS = 2;
/** How long the one-line plan of a step may be. */
export const MAX_PLAN_CHARS = 240;
/**
 * How many tool steps one reply may take.
 *
 * A multi-step task — "list the files in these three folders and count them" —
 * needs one step per folder plus the answer, so the old default of two cut the
 * work in half. `INFAGENT_MAX_STEPS` tunes it; the request may override.
 */
export function stepBudget(requested) {
    const fromEnv = Number(process.env['INFAGENT_MAX_STEPS']);
    const value = requested ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STEPS);
    return Math.max(1, Math.min(12, Math.round(value)));
}
/** Steps per reply when neither the request nor the environment say otherwise. */
export const DEFAULT_STEPS = 6;
/** Literal examples, shared by the system prompt and the repair turn. */
export const TOOL_CALL_EXAMPLE = '{"type":"tool_call","plan":"List the scripts first","calls":[{"name":"listScripts","arguments":{}}]}';
export const FINAL_EXAMPLE = '{"type":"final","content":"You have three scripts: hello, system_info, net_interfaces."}';
/** The one rule that is about *results*, in the model's words. */
export const RESULT_RULE = 'A {"type":"tool_result",…} object is written by InfAgent after it runs your call. ' +
    'You never write one: you either call a tool, or you answer.';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** ```json … ``` around the object is tolerated; nothing else is. */
function unfence(text) {
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    return match?.[1] ?? text;
}
/**
 * Parse a reply that must be one envelope.
 *
 * `toolNames` is the toolbox as offered to the model in this turn; a call to
 * anything else is rejected here exactly like the grammar rejects it.
 */
export function parseEnvelope(text, options = {}) {
    const toolNames = (options.toolNames ?? []).filter((name) => name.length > 0);
    const body = unfence(text.trim());
    if (body.length === 0)
        return { ok: false, reason: 'the reply was empty' };
    if (!body.startsWith('{')) {
        return { ok: false, reason: 'the reply must be a single JSON object, starting with "{"' };
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : 'parse error';
        return { ok: false, reason: `the reply is not valid JSON (${detail})` };
    }
    if (!isRecord(parsed))
        return { ok: false, reason: 'the reply must be a single JSON object' };
    const type = parsed['type'];
    if (type === 'tool_result') {
        return {
            ok: false,
            reason: 'type "tool_result" is produced by InfAgent, never by you — reply with "tool_call" or "final"',
        };
    }
    if (type === 'tool_call') {
        if (toolNames.length === 0) {
            return {
                ok: false,
                reason: 'no tool is available in this turn, so "tool_call" is not allowed',
            };
        }
        const raw = parsed['calls'];
        if (!Array.isArray(raw) || raw.length === 0) {
            return { ok: false, reason: '"tool_call" needs a non-empty "calls" array' };
        }
        const calls = [];
        for (const [index, item] of raw.entries()) {
            if (!isRecord(item))
                return { ok: false, reason: `calls[${index}] must be a JSON object` };
            const name = item['name'];
            if (typeof name !== 'string' || name.length === 0) {
                return { ok: false, reason: `calls[${index}] needs a "name"` };
            }
            if (!toolNames.includes(name)) {
                return {
                    ok: false,
                    reason: `"${name}" is not a tool in this turn (available: ${toolNames.join(', ')})`,
                };
            }
            const args = item['arguments'];
            if (args !== undefined && !isRecord(args)) {
                return { ok: false, reason: `"arguments" of ${name} must be a JSON object` };
            }
            calls.push({ name, arguments: args ?? {} });
        }
        const plan = parsed['plan'];
        if (plan !== undefined && typeof plan !== 'string') {
            return { ok: false, reason: '"plan" must be a string (or omitted)' };
        }
        const text = typeof plan === 'string' ? plan.trim().slice(0, MAX_PLAN_CHARS) : '';
        return {
            ok: true,
            envelope: { type: 'tool_call', calls, ...(text.length > 0 ? { plan: text } : {}) },
        };
    }
    if (type === 'final') {
        const content = parsed['content'];
        if (typeof content !== 'string') {
            return { ok: false, reason: '"final" needs a "content" string' };
        }
        if (content.trim().length === 0) {
            return { ok: false, reason: 'the "content" of "final" was empty — answer the user' };
        }
        return { ok: true, envelope: { type: 'final', content } };
    }
    return {
        ok: false,
        reason: `"type" must be "tool_call" or "final", not ${JSON.stringify(type)}`,
    };
}
/**
 * The grammar for a turn that must end in an answer (the step budget is spent).
 * Only `final` is representable, so the model cannot open yet another step.
 */
export function finalOnlyGrammarSchema() {
    return {
        type: 'object',
        properties: {
            type: { const: 'final' },
            content: { type: 'string' },
        },
    };
}
/**
 * Which protocol applies to this turn.
 *
 * The model's settings file wins (`toolProtocol`), the environment can override
 * every model at once (`INFAGENT_TOOL_PROTOCOL=legacy` is the escape hatch that
 * restores the pre-protocol behaviour), and the default is the strict envelope.
 */
export function resolveProtocolMode(preferred) {
    const fromEnv = (process.env['INFAGENT_TOOL_PROTOCOL'] ?? '').trim().toLowerCase();
    if (fromEnv === 'legacy' || fromEnv === 'native' || fromEnv === 'strict-json')
        return fromEnv;
    return preferred ?? 'strict-json';
}
/** Constrained decoding is on unless `INFAGENT_TOOL_GRAMMAR=0` turns it off. */
export function grammarEnabled() {
    return (process.env['INFAGENT_TOOL_GRAMMAR'] ?? '').trim() !== '0';
}
/**
 * The protocol as a llama.cpp JSON-schema grammar.
 *
 * `enum` on the tool name is what makes a call to an unoffered tool impossible
 * rather than merely unlikely.
 */
export function envelopeGrammarSchema(toolNames) {
    const names = [...new Set(toolNames.filter((name) => name.length > 0))];
    return {
        oneOf: [
            {
                type: 'object',
                properties: {
                    type: { const: 'tool_call' },
                    // The model states what this step is for; it may be empty when the
                    // call is obvious. Required in the schema because this grammar
                    // implementation treats every listed property as mandatory.
                    plan: { type: 'string' },
                    calls: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                name: names.length > 0 ? { enum: names } : { type: 'string' },
                                // Permissive on purpose: every tool schema is already in the
                                // system prompt, and a wrong argument is a normal tool error.
                                arguments: { type: 'object', additionalProperties: true },
                            },
                        },
                    },
                },
            },
            {
                type: 'object',
                properties: {
                    type: { const: 'final' },
                    content: { type: 'string' },
                },
            },
        ],
    };
}
/** The correction turn sent when a reply did not parse. */
export function envelopeRepairPrompt(reason) {
    return [
        `Your previous reply was rejected: ${reason}.`,
        '',
        'Reply with exactly one JSON object and nothing else — no prose, no code fence:',
        '',
        `  to call a tool:  ${TOOL_CALL_EXAMPLE}`,
        `  to answer:       ${FINAL_EXAMPLE}`,
        '',
        RESULT_RULE,
    ].join('\n');
}
/** The `tool_result` object the engine injects after running the calls. */
export function resultEnvelope(calls) {
    return JSON.stringify({
        type: 'tool_result',
        calls: calls.map((call) => call.ok
            ? { name: call.name, ok: true, result: call.result ?? null }
            : { name: call.name, ok: false, error: call.error ?? 'failed' }),
    });
}
/**
 * Incremental decoder for a streamed envelope.
 *
 * While the reply is generated this keeps the JSON away from the user and
 * releases exactly the `content` string of a `final` envelope, escapes decoded
 * as they arrive. Anything that is not an envelope — prose, which is what the
 * model answers when no tool is needed and the grammar is off — streams through
 * unchanged, so the interface never loses text.
 */
export class ProtocolStream {
    buffer = '';
    state = 'undecided';
    /** Partial escape at the end of the buffer: `\` or `\u`. */
    escape = '';
    /** Feed a raw chunk; returns the events it produced. */
    push(chunk) {
        if (this.state === 'after')
            return [];
        this.buffer += chunk;
        const events = [];
        this.consume(events);
        return events;
    }
    /** End of generation: release what a text reply still holds back. */
    flush() {
        if (this.state !== 'text' || this.buffer.length === 0)
            return [];
        const remaining = this.buffer;
        this.buffer = '';
        return [{ type: 'token', text: remaining }];
    }
    consume(events) {
        for (;;) {
            if (this.state === 'text') {
                if (this.buffer.length === 0)
                    return;
                events.push({ type: 'token', text: this.buffer });
                this.buffer = '';
                return;
            }
            if (this.state === 'after' || this.state === 'hidden') {
                this.buffer = '';
                return;
            }
            if (this.state === 'content') {
                this.takeContent(events);
                return;
            }
            if (this.state === 'final') {
                const opener = /"content"\s*:\s*"/.exec(this.buffer);
                if (!opener) {
                    // `content` has not started yet; a runaway buffer is not an envelope.
                    if (this.buffer.length > 4000) {
                        this.state = 'hidden';
                        this.buffer = '';
                    }
                    return;
                }
                this.buffer = this.buffer.slice(opener.index + opener[0].length);
                this.state = 'content';
                continue;
            }
            // state === 'undecided'
            const head = this.buffer.replace(/^\s+/, '');
            if (head.length === 0)
                return;
            // A thinking block may precede the object when the grammar is off.
            if (head.toLowerCase().startsWith('<think>')) {
                const close = head.toLowerCase().indexOf('</think>');
                if (close === -1)
                    return;
                const inner = head.slice('<think>'.length, close);
                if (inner.length > 0)
                    events.push({ type: 'thinking', text: inner });
                this.buffer = head.slice(close + '</think>'.length);
                continue;
            }
            if (!head.startsWith('{')) {
                // Not an envelope: stream it as ordinary text.
                this.state = 'text';
                this.buffer = head;
                continue;
            }
            const decided = /"type"\s*:\s*"([a-zA-Z_]+)"/.exec(head);
            if (!decided) {
                // The type is still being generated — or this is prose that happens to
                // start with a brace.
                if (head.length > 400) {
                    this.state = 'text';
                    this.buffer = head;
                    continue;
                }
                return;
            }
            if (decided[1] !== 'final') {
                // `tool_call`, a malformed type, or the model writing `tool_result`
                // itself: hidden either way — the parser and the repair turn decide.
                this.state = 'hidden';
                this.buffer = '';
                return;
            }
            this.state = 'final';
            this.buffer = head.slice(decided.index + decided[0].length);
        }
    }
    /** Decode what has arrived of the `content` string. */
    takeContent(events) {
        let out = '';
        let index = 0;
        while (index < this.buffer.length) {
            const char = this.buffer[index];
            if (this.escape === 'unicode') {
                const hex = this.buffer.slice(index, index + 4);
                if (hex.length < 4)
                    break;
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                    this.escape = '';
                    continue;
                }
                out += String.fromCharCode(parseInt(hex, 16));
                index += 4;
                this.escape = '';
                continue;
            }
            if (this.escape === 'slash') {
                this.escape = '';
                index += 1;
                if (char === 'n')
                    out += '\n';
                else if (char === 't')
                    out += '\t';
                else if (char === 'r')
                    out += '\r';
                else if (char === 'b')
                    out += '\b';
                else if (char === 'f')
                    out += '\f';
                else if (char === 'u')
                    this.escape = 'unicode';
                else
                    out += char;
                continue;
            }
            if (char === '\\') {
                this.escape = 'slash';
                index += 1;
                continue;
            }
            if (char === '"') {
                this.state = 'after';
                index += 1;
                break;
            }
            out += char;
            index += 1;
        }
        this.buffer = this.buffer.slice(index);
        if (out.length > 0)
            events.push({ type: 'token', text: out });
    }
}
//# sourceMappingURL=protocol.js.map
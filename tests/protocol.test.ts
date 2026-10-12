import { describe, expect, it } from 'vitest';

import {
  FINAL_EXAMPLE,
  TOOL_CALL_EXAMPLE,
  ProtocolStream,
  envelopeGrammarSchema,
  envelopeRepairPrompt,
  parseEnvelope,
  resultEnvelope,
} from '../src/chat/protocol.js';
import type { ChatEvent } from '../src/chat/types.js';

const TOOLS = ['listScripts', 'createScript', 'runScript'];

const text = (events: ChatEvent[]): string =>
  events
    .filter((event): event is { type: 'token'; text: string } => event.type === 'token')
    .map((event) => event.text)
    .join('');

describe('parseEnvelope', () => {
  it('reads a tool call', () => {
    const result = parseEnvelope(TOOL_CALL_EXAMPLE, { toolNames: TOOLS });
    expect(result).toEqual({
      ok: true,
      envelope: { type: 'tool_call', calls: [{ name: 'listScripts', arguments: {} }] },
    });
  });

  it('reads several calls and keeps their arguments', () => {
    const result = parseEnvelope(
      '{"type":"tool_call","calls":[{"name":"runScript","arguments":{"name":"hello"}},' +
        '{"name":"listScripts","arguments":{}}]}',
      { toolNames: TOOLS },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.type).toBe('tool_call');
    if (result.envelope.type !== 'tool_call') return;
    expect(result.envelope.calls).toEqual([
      { name: 'runScript', arguments: { name: 'hello' } },
      { name: 'listScripts', arguments: {} },
    ]);
  });

  it('reads a final answer and keeps the content verbatim', () => {
    const result = parseEnvelope('{"type":"final","content":"Line one.\\nLine two."}', {
      toolNames: TOOLS,
    });
    expect(result).toEqual({
      ok: true,
      envelope: { type: 'final', content: 'Line one.\nLine two.' },
    });
  });

  it('tolerates a json code fence and surrounding whitespace', () => {
    expect(
      parseEnvelope(`\n  \`\`\`json\n${FINAL_EXAMPLE}\n\`\`\`\n`, { toolNames: TOOLS }).ok,
    ).toBe(true);
  });

  it('treats a missing arguments object as empty', () => {
    const result = parseEnvelope('{"type":"tool_call","calls":[{"name":"listScripts"}]}', {
      toolNames: TOOLS,
    });
    expect(result.ok && result.envelope.type === 'tool_call' && result.envelope.calls[0]).toEqual({
      name: 'listScripts',
      arguments: {},
    });
  });

  it('refuses prose around the object', () => {
    const result = parseEnvelope(`Sure! ${FINAL_EXAMPLE}`, { toolNames: TOOLS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/single JSON object/);
  });

  it('refuses a tool that was not offered, and names the toolbox', () => {
    const result = parseEnvelope(
      '{"type":"tool_call","calls":[{"name":"selfDestruct","arguments":{}}]}',
      {
        toolNames: TOOLS,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"selfDestruct" is not a tool');
      expect(result.reason).toContain('listScripts, createScript, runScript');
    }
  });

  it('refuses a call when no tool is available', () => {
    const result = parseEnvelope(TOOL_CALL_EXAMPLE, { toolNames: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no tool is available/);
  });

  it('refuses a result written by the model itself', () => {
    const result = parseEnvelope(
      '{"type":"tool_result","calls":[{"name":"listScripts","ok":true}]}',
      {
        toolNames: TOOLS,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/produced by InfAgent, never by you/);
  });

  it('names the offending part of a malformed call', () => {
    const cases: [string, RegExp][] = [
      ['{"type":"tool_call","calls":[]}', /non-empty "calls"/],
      ['{"type":"tool_call","calls":[{}]}', /calls\[0\] needs a "name"/],
      [
        '{"type":"tool_call","calls":[{"name":"listScripts","arguments":null}]}',
        /must be a JSON object/,
      ],
      ['{"type":"final"}', /needs a "content" string/],
      ['{"type":"final","content":"  "}', /was empty/],
      ['{"type":"chat"}', /must be "tool_call" or "final"/],
      ['{"type":"final","content":"ok"', /not valid JSON/],
      ['just an answer', /single JSON object/],
      ['', /was empty/],
    ];
    for (const [input, pattern] of cases) {
      const result = parseEnvelope(input, { toolNames: TOOLS });
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.reason, input).toMatch(pattern);
    }
  });
});

describe('envelopeGrammarSchema', () => {
  it('offers exactly the two envelopes, with the toolbox as an enum', () => {
    const schema = envelopeGrammarSchema([...TOOLS, 'listScripts']) as {
      oneOf: { properties: Record<string, { const?: string; enum?: string[] }> }[];
    };
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.oneOf[0]?.properties['type']?.const).toBe('tool_call');
    expect(schema.oneOf[1]?.properties['type']?.const).toBe('final');
    const items = schema.oneOf[0]?.properties['calls'] as unknown as {
      items: { properties: { name: { enum: string[] } } };
    };
    expect(items.items.properties.name.enum).toEqual([...TOOLS]);
  });

  it('falls back to a free name when nothing is offered', () => {
    const schema = JSON.stringify(envelopeGrammarSchema([]));
    expect(schema).toContain('"final"');
    expect(schema).not.toContain('"enum"');
  });
});

describe('the repair turn and the result envelope', () => {
  it('quotes the reason and both examples', () => {
    const prompt = envelopeRepairPrompt('"type" must be "tool_call" or "final", not undefined');
    expect(prompt).toContain('was rejected: "type" must be');
    expect(prompt).toContain(TOOL_CALL_EXAMPLE);
    expect(prompt).toContain(FINAL_EXAMPLE);
    expect(prompt).toMatch(/tool_result/);
  });

  it('wraps results so the model can tell a result from a call', () => {
    const envelope = JSON.parse(
      resultEnvelope([
        { name: 'listScripts', ok: true, result: { scripts: [] } },
        { name: 'runScript', ok: false, error: 'not found' },
      ]),
    );
    expect(envelope).toEqual({
      type: 'tool_result',
      calls: [
        { name: 'listScripts', ok: true, result: { scripts: [] } },
        { name: 'runScript', ok: false, error: 'not found' },
      ],
    });
  });
});

describe('ProtocolStream', () => {
  it('releases the content of a final envelope and hides the JSON', async () => {
    const stream = new ProtocolStream();
    const events = [
      ...stream.push('{"type":"fi'),
      ...stream.push('nal","content":"Hel'),
      ...stream.push('lo there"}'),
      ...stream.flush(),
    ];
    expect(text(events)).toBe('Hello there');
    expect(text(events)).not.toContain('final');
  });

  it('decodes escapes, even one character at a time', () => {
    // The JSON text is
    //   {"type":"final","content":"a\nb\t\"c\u00e9 \uD83D\uDE00"}
    // and the answer it carries is  a<LF>b<TAB>"c\u00e9 \u{1F600}
    const raw = '{"type":"final","content":"a\\nb\\t\\"c\\u00e9 \\uD83D\\uDE00"}';
    const expected = 'a\nb\t"c\u00e9 \u{1F600}';

    for (const size of [1, 2, 3, 7, 100]) {
      const stream = new ProtocolStream();
      const events: ChatEvent[] = [];
      for (let index = 0; index < raw.length; index += size) {
        events.push(...stream.push(raw.slice(index, index + size)));
      }
      events.push(...stream.flush());
      expect(text(events), `chunk size ${size}`).toBe(expected);
    }
  });

  it('shows nothing for a tool call', () => {
    const stream = new ProtocolStream();
    const events = [...stream.push(TOOL_CALL_EXAMPLE), ...stream.flush()];
    expect(text(events)).toBe('');
  });

  it('passes a prose answer through untouched', () => {
    const stream = new ProtocolStream();
    const events = [...stream.push('Sure, '), ...stream.push('here it is.'), ...stream.flush()];
    expect(text(events)).toBe('Sure, here it is.');
  });

  it('folds a leading thinking block into a thinking event', () => {
    const stream = new ProtocolStream();
    const events = [
      ...stream.push('<think>weighing options</think>{"type":"final","content":"Done"}'),
    ];
    expect(events[0]).toEqual({ type: 'thinking', text: 'weighing options' });
    expect(text(events)).toBe('Done');
  });

  it('holds an unterminated envelope instead of showing raw JSON', () => {
    const stream = new ProtocolStream();
    const events = [...stream.push('{"type":"final","content":"half'), ...stream.flush()];
    expect(text(events)).toBe('half');
  });
});

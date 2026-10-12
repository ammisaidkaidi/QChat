import { describe, expect, it } from 'vitest';

import { OutputSplitter, stripThinking } from '../src/chat/splitter.js';
import { dispatchTool, extractToolCalls } from '../src/chat/tools.js';
import {
  answerUsesResult,
  asksAboutToolbox,
  buildSystemPrompt,
  fallbackAnswer,
  formatToolResult,
  toolResultPrompt,
} from '../src/chat/prompt.js';
import { ScriptRegistry } from '../src/scripts/registry.js';
import type { ChatEvent } from '../src/chat/types.js';

const text = (events: ChatEvent[]): string =>
  events
    .filter((e): e is { type: 'token'; text: string } => e.type === 'token')
    .map((e) => e.text)
    .join('');
const think = (events: ChatEvent[]): string =>
  events
    .filter((e): e is { type: 'thinking'; text: string } => e.type === 'thinking')
    .map((e) => e.text)
    .join('');

describe('OutputSplitter', () => {
  it('separates a thinking block from the answer', () => {
    const splitter = new OutputSplitter();
    const events = [
      ...splitter.push('<think>\nLet me consider.\n</think>'),
      ...splitter.push('Hello!'),
      ...splitter.flush(),
    ];
    expect(think(events)).toContain('Let me consider.');
    expect(text(events).trim()).toBe('Hello!');
  });

  it('handles tags split across chunk boundaries', () => {
    const splitter = new OutputSplitter();
    const events = [
      ...splitter.push('<thi'),
      ...splitter.push('nk>reasoning'),
      ...splitter.push('</thi'),
      ...splitter.push('nk>Visible'),
      ...splitter.flush(),
    ];
    expect(think(events)).toContain('reasoning');
    expect(text(events).trim()).toBe('Visible');
  });

  it('hides tool-call blocks from the visible stream', () => {
    const splitter = new OutputSplitter();
    const events = [
      ...splitter.push('Let me check.\n<tool_call>\n{"name": "hello", "args": {}}\n</tool_call>\n'),
      ...splitter.flush(),
    ];
    const visible = text(events);
    expect(visible).toContain('Let me check.');
    expect(visible).not.toContain('tool_call');
  });

  it('strips thinking and tool blocks from a finished reply', () => {
    expect(stripThinking('<think>hmm</think>\nAnswer<tool_call>{"name":"x"}</tool_call>')).toBe(
      'Answer',
    );
  });
});

describe('extractToolCalls', () => {
  it('reads the flat Qwen3 shape', () => {
    const { calls, rest } = extractToolCalls(
      'Sure.\n<tool_call>{"name":"hello","args":{"name":"Sara"}}</tool_call>',
    );
    expect(calls).toEqual([{ name: 'hello', args: { name: 'Sara' } }]);
    expect(rest.trim()).toBe('Sure.');
  });

  it('reads the nested runScript shape and `arguments`', () => {
    const { calls } = extractToolCalls(
      '<tool_call>{"name":"runScript","arguments":{"name":"disk_report","args":{"min_free_gb":5}}}</tool_call>',
    );
    expect(calls[0]?.name).toBe('runScript');
    expect(calls[0]?.args).toEqual({ name: 'disk_report', args: { min_free_gb: 5 } });
  });

  it('accepts a fenced code block naming a built-in tool', () => {
    const { calls } = extractToolCalls('```json\n{"name": "listScripts"}\n```');
    expect(calls[0]?.name).toBe('listScripts');
  });

  it('accepts the tool name as the only key', () => {
    const { calls } = extractToolCalls('<tool_call>{"listScripts": {}}</tool_call>');
    expect(calls).toEqual([{ name: 'listScripts', args: {} }]);
  });

  it('salvages an unterminated block when generation stops after the JSON', () => {
    const { calls, rest } = extractToolCalls(
      '<think></think>\n<tool_call>\n{"name": "listScripts"}',
    );
    expect(calls[0]?.name).toBe('listScripts');
    expect(rest).not.toContain('listScripts');
  });

  it('salvages a bare JSON call with no tags, dropping it from the text', () => {
    const { calls, rest } = extractToolCalls(
      '<think>\n</think>\n{"name": "listScripts", "arguments": {}}\n</tool_call>',
    );
    expect(calls).toEqual([{ name: 'listScripts', args: {} }]);
    expect(rest).not.toContain('listScripts');
    expect(rest).not.toContain('tool_call');
  });

  it('accepts the tool name as a key when the value holds the answer', () => {
    const { calls } = extractToolCalls(
      '<think>\n</think>\n{"list_scripts": [{"name": "hello"}]}\n</tool_call>',
      { knownScripts: ['hello', 'disk_report'] },
    );
    expect(calls[0]?.name).toBe('list_scripts');
  });

  it('does not mistake prose JSON for a call', () => {
    const { calls } = extractToolCalls('Sure: {"cities": ["Algiers", "Oran"]}', {
      knownScripts: ['hello'],
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves ordinary JSON in a reply alone', () => {
    const { calls, rest } = extractToolCalls('Here is some JSON: {"city": "Algiers"}');
    expect(calls).toHaveLength(0);
    expect(rest).toContain('Algiers');
  });

  it('reads the bare JSON array Hammer2.1 and xLAM emit', () => {
    const { calls, rest } = extractToolCalls(
      '[{"name": "listScripts", "arguments": {}}, {"name": "hello", "arguments": {"name": "Sara"}}]',
      { knownScripts: ['hello', 'disk_report'] },
    );
    expect(calls).toEqual([
      { name: 'listScripts', args: {} },
      { name: 'hello', args: { name: 'Sara' } },
    ]);
    expect(rest.trim()).toBe('');
  });

  it('reads an array of calls that is still wrapped in the Qwen3 tags', () => {
    const { calls } = extractToolCalls(
      '<tool_call>[{"name":"runScript","arguments":{"name":"hello"}}]</tool_call>',
    );
    expect(calls).toEqual([{ name: 'runScript', args: { name: 'hello' } }]);
  });

  it('keeps the real calls and drops invented ones from an array', () => {
    const { calls } = extractToolCalls(
      '[{"name": "hello", "arguments": {}}, {"name": "totally_made_up", "arguments": {}}]',
      { knownScripts: ['hello'] },
    );
    expect(calls).toEqual([{ name: 'hello', args: {} }]);
  });

  it('does not turn a plain JSON array in prose into a call', () => {
    const { calls, rest } = extractToolCalls('Cities: ["Algiers", "Oran"]', {
      knownScripts: ['hello'],
    });
    expect(calls).toHaveLength(0);
    expect(rest).toContain('Oran');

    // An empty list is how Hammer2.1 declines to call anything.
    expect(extractToolCalls('[]').calls).toHaveLength(0);
  });

  it('prefers the outer object when a call carries an array inside it', () => {
    const { calls } = extractToolCalls('{"list_scripts": [{"name": "hello"}]}', {
      knownScripts: ['hello'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('list_scripts');
  });

  it('ignores malformed blocks and deduplicates', () => {
    const { calls } = extractToolCalls(
      '<tool_call>not json</tool_call><tool_call>{"name":"a","args":{}}</tool_call><tool_call>{"name":"a","args":{}}</tool_call>',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('chat prompt styles', () => {
  const registry = new ScriptRegistry({ root: '/tmp/infagent-style-test' });

  it('declares the Qwen3 convention for a qwen3 model', () => {
    const prompt = buildSystemPrompt({ records: registry.list(), tools: true, thinking: false });
    expect(prompt).toContain('/no_think');
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('<tools>');
  });

  it('keeps the tool block inside its budget and names what did not fit', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      server: 'fake',
      name: `tool_${index}`,
      description: `Tool number ${index}. `.repeat(6),
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Where to look.'.repeat(6) } },
        required: ['path'],
      },
    }));

    const prompt = buildSystemPrompt({
      records: registry.list(),
      tools: true,
      thinking: false,
      mcp: many,
      toolBudget: 3000,
    });

    const block = prompt.slice(prompt.indexOf('# Tools'), prompt.indexOf('These tools exist'));
    expect(block.length).toBeLessThan(6000);
    expect(prompt).toContain('These tools exist too');
    expect(prompt).toMatch(/fake__tool_39/);
    // Declarations stay valid JSON with the schema the server declared.
    const declaration = prompt
      .split('\n')
      .find((line) => line.includes('fake__tool_0"'));
    expect(declaration).toBeDefined();
    const parsed = JSON.parse(declaration ?? '{}');
    expect(parsed.function.parameters.properties.path.type).toBe('string');
    expect(parsed.function.description.length).toBeLessThanOrEqual(120);
  });

  it('declares the JSON-array convention for a Hammer2.1 / xLAM model', () => {
    const prompt = buildSystemPrompt({
      records: registry.list(),
      tools: true,
      thinking: false,
      style: 'xlam',
    });
    // No Qwen3-only thinking switch, and the call shape it was trained on.
    expect(prompt).not.toContain('/no_think');
    expect(prompt).not.toContain('<tool_call>');
    expect(prompt).toContain('[BEGIN OF AVAILABLE_TOOLS]');
    expect(prompt).toContain('[END OF AVAILABLE_TOOLS]');
    expect(prompt).toContain('single JSON array');
  });
});

describe('chat prompt', () => {
  const registry = new ScriptRegistry({ root: '/tmp/infagent-prompt-test' });

  it('declares scripts as tools in the Qwen3 format', () => {
    const prompt = buildSystemPrompt({
      records: [
        {
          meta: {
            version: 'infagent-script/v1',
            name: 'hello',
            language: 'js',
            description: 'Greet someone.',
            callback: 'run(args)',
            usage: 'node scripts/hello.js',
            params: [{ name: 'name', type: 'string', required: true }],
            agentPrompt: '',
          },
          file: '/tmp/hello.js',
          relativePath: 'scripts/hello.js',
          bytes: 10,
          modifiedAt: '2026-01-01T00:00:00Z',
        },
      ],
      tools: true,
      thinking: false,
    });

    expect(prompt).toContain('<tools>');
    expect(prompt).toContain('{"type":"function","function":{"name":"hello"');
    expect(prompt).toContain('"required":["name"]');
    expect(prompt).toContain('/no_think');
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain('# Tools');
  });

  it('announces when tools are disabled', () => {
    const prompt = buildSystemPrompt({ records: [], tools: false, thinking: false });
    expect(prompt).toContain('no tools');
    expect(prompt).not.toContain('<tools>');
  });

  it('flattens tool output and anchors the question', () => {
    const rendered = formatToolResult({ ok: true, result: { greeting: 'Hello!', host: 'box' } });
    expect(rendered).toContain('greeting: Hello!');
    expect(rendered).not.toContain('{');

    const prompt = toolResultPrompt(['hello → greeting: Hello!'], 'greet Sara');
    expect(prompt.startsWith('<tool_response>')).toBe(true);
    expect(prompt.indexOf('greet Sara')).toBeGreaterThan(prompt.indexOf('greeting: Hello!'));
  });

  it('builds a readable fallback when the model returns nothing usable', () => {
    expect(fallbackAnswer('hello', { ok: true, result: { greeting: 'Hi!' } })).toBe(
      'hello → greeting: Hi!',
    );
  });

  it('recognises questions about the toolbox', () => {
    for (const text of [
      'Which scripts do you have?',
      'which scripts are available',
      'List my tools',
      'What can you do?',
      'do you have any scripts installed?',
    ]) {
      expect(asksAboutToolbox(text), text).toBe(true);
    }
    for (const text of [
      'Use a tool to greet Yacine',
      'What is the capital of Algeria?',
      'Explain what a disk report script usually does in one line.',
      'Hello!',
    ]) {
      expect(asksAboutToolbox(text), text).toBe(false);
    }
  });

  it('repairs mangled tool names instead of failing', async () => {
    const call = await dispatchTool(
      { name: 'list_scripts', args: {} },
      { registry, allowRun: false },
    );
    expect(call.ok).toBe(true);
    // the canonical name is reported back so the UI card is unambiguous
    expect(call.name).toBe('listScripts');
    expect(Array.isArray(call.result)).toBe(true);
  });

  it('reports unknown tools as failures rather than throwing', async () => {
    const call = await dispatchTool(
      { name: 'deleteEverything', args: {} },
      { registry, allowRun: false },
    );
    expect(call.ok).toBe(false);
    expect(String(call.error)).toContain('deleteEverything');
  });

  it('notices when a reply ignores the tool result', () => {
    const listed = [
      { name: 'hello', description: 'Greet someone.' },
      { name: 'disk_report', description: 'Report disk space.' },
    ];
    expect(answerUsesResult('The scripts I have are hello and disk_report.', listed)).toBe(true);
    expect(answerUsesResult('I have several scripts available.', listed)).toBe(false);
    expect(
      answerUsesResult('Hello, Yacine!', { ok: true, result: { greeting: 'Hello, Yacine!' } }),
    ).toBe(true);
  });

  it('exposes the registry for wiring (smoke)', () => {
    expect(registry.list()).toEqual([]);
  });
});

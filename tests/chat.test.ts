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

  it('ignores malformed blocks and deduplicates', () => {
    const { calls } = extractToolCalls(
      '<tool_call>not json</tool_call><tool_call>{"name":"a","args":{}}</tool_call><tool_call>{"name":"a","args":{}}</tool_call>',
    );
    expect(calls).toHaveLength(1);
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

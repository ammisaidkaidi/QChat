import { describe, expect, it } from 'vitest';

import { OutputSplitter, stripThinking } from '../src/chat/splitter.js';
import { extractToolCalls } from '../src/chat/tools.js';
import {
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

  it('salvages an unterminated block when generation stops after the JSON', () => {
    const { calls, rest } = extractToolCalls(
      '<think></think>\n<tool_call>\n{"name": "listScripts"}',
    );
    expect(calls[0]?.name).toBe('listScripts');
    expect(rest).not.toContain('listScripts');
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
    expect(prompt).toContain('"name":"hello"');
    expect(prompt).toContain('"required":["name"]');
    expect(prompt).toContain('/no_think');
    expect(prompt).toContain('<tool_call>');
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

    const prompt = toolResultPrompt(['- hello → greeting: Hello!'], 'greet Sara');
    expect(prompt.indexOf('greet Sara')).toBeGreaterThan(prompt.indexOf('greeting: Hello!'));
  });

  it('builds a readable fallback when the model returns nothing usable', () => {
    expect(fallbackAnswer('hello', { ok: true, result: { greeting: 'Hi!' } })).toBe(
      'hello → greeting: Hi!',
    );
  });

  it('exposes the registry for wiring (smoke)', () => {
    expect(registry.list()).toEqual([]);
  });
});

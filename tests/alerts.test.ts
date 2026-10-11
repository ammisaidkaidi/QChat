import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AlertBus, AlertError, asAlertInput } from '../src/capabilities/alerts.js';
import { buildSystemPrompt } from '../src/chat/prompt.js';
import { dispatchTool } from '../src/chat/tools.js';
import { ScriptRegistry } from '../src/scripts/registry.js';

describe('alert input', () => {
  it('accepts a bare message and defaults the rest', () => {
    expect(asAlertInput({ message: '  Salut  ' })).toEqual({
      message: 'Salut',
      title: 'Notice',
      level: 'info',
    });
  });

  it('honours title, level and the `text` alias', () => {
    expect(asAlertInput({ text: 'Deploy done', title: 'Release', level: 'SUCCESS' })).toEqual({
      message: 'Deploy done',
      title: 'Release',
      level: 'success',
    });
  });

  it('refuses an empty message or an unknown level', () => {
    expect(() => asAlertInput({})).toThrow(AlertError);
    expect(() => asAlertInput({ message: 'hi', level: 'loud' })).toThrow(/Unknown alert level/);
  });
});

describe('AlertBus', () => {
  it('stores alerts newest-first and clears them', () => {
    const bus = new AlertBus();
    const first = bus.raise({ message: 'one' }, 'cli');
    const second = bus.raise({ message: 'two', level: 'warning' }, 'agent');

    expect(bus.size).toBe(2);
    expect(bus.list().map((alert) => alert.message)).toEqual(['two', 'one']);
    expect(bus.get(second.id)?.level).toBe('warning');
    expect(bus.get(first.id)?.source).toBe('cli');
    expect(bus.clear()).toBe(2);
    expect(bus.list()).toEqual([]);
  });

  it('keeps only the most recent alerts', () => {
    const bus = new AlertBus({ limit: 3 });
    for (let index = 1; index <= 5; index += 1) bus.raise({ message: `#${index}` });
    expect(bus.list(10).map((alert) => alert.message)).toEqual(['#5', '#4', '#3']);
  });

  it('notifies subscribers and stops on unsubscribe', () => {
    const bus = new AlertBus();
    const seen: string[] = [];
    const stop = bus.subscribe((alert) => seen.push(alert.message));

    bus.raise({ message: 'first' });
    stop();
    bus.raise({ message: 'second' });

    expect(seen).toEqual(['first']);
  });

  it('survives a listener that throws', () => {
    const bus = new AlertBus();
    bus.subscribe(() => {
      throw new Error('broken listener');
    });
    expect(() => bus.raise({ message: 'still fine' })).not.toThrow();
    expect(bus.size).toBe(1);
  });
});

describe('showAlert tool', () => {
  it('raises on the bus and reports what was shown', async () => {
    const bus = new AlertBus();
    const registry = new ScriptRegistry({ root: mkdtempSync(join(tmpdir(), 'infagent-alerts-')) });

    const call = await dispatchTool(
      { name: 'showAlert', args: { message: 'Tea is ready', level: 'warning' } },
      { registry, alerts: bus },
    );

    expect(call.ok).toBe(true);
    expect(call.result).toMatchObject({ shown: true, level: 'warning', message: 'Tea is ready' });
    expect(bus.list()[0]?.message).toBe('Tea is ready');
    expect(bus.list()[0]?.source).toBe('agent');
  });

  it('accepts the snake_case name the model sometimes emits', async () => {
    const bus = new AlertBus();
    const registry = new ScriptRegistry({ root: mkdtempSync(join(tmpdir(), 'infagent-alerts-')) });

    const call = await dispatchTool(
      { name: 'show_alert', args: { text: 'Renamed call' } },
      { registry, alerts: bus },
    );

    expect(call.ok).toBe(true);
    expect(bus.list()[0]?.message).toBe('Renamed call');
  });

  it('fails cleanly without a message and without a bus', async () => {
    const registry = new ScriptRegistry({ root: mkdtempSync(join(tmpdir(), 'infagent-alerts-')) });

    const empty = await dispatchTool(
      { name: 'showAlert', args: {} },
      { registry, alerts: new AlertBus() },
    );
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/needs a `message`/);

    const detached = await dispatchTool(
      { name: 'showAlert', args: { message: 'nobody is listening' } },
      { registry },
    );
    expect(detached.ok).toBe(false);
  });
});

describe('prompt', () => {
  it('declares showAlert even with the internet switched off', () => {
    const prompt = buildSystemPrompt({ records: [], tools: true, thinking: false, net: false });
    expect(prompt).toContain('showAlert');
    expect(prompt).not.toContain('webSearch');
  });

  it('declares the internet tools only when net is on', () => {
    const prompt = buildSystemPrompt({ records: [], tools: true, thinking: false, net: true });
    expect(prompt).toContain('webSearch');
    expect(prompt).toContain('showAlert');
  });
});

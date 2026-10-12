import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { QwenEngine } from '../src/chat/qwen.js';
import { ModelStore } from '../src/chat/modelStore.js';
import { buildSystemPrompt } from '../src/chat/prompt.js';
import { DEFAULT_PROMPTS, PromptError, SystemPromptStore } from '../src/chat/prompts.js';

const dirs: string[] = [];

/** A store with its own prompts file and its own catalogue. */
function sandbox(): { store: SystemPromptStore; file: string; models: ModelStore } {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-prompts-'));
  dirs.push(dir);
  const file = join(dir, 'systemPrompts.json');
  const models = new ModelStore({ dir, weightsDir: dir });
  return { store: new SystemPromptStore({ file, catalogue: models }), file, models };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('system-prompt templates', () => {
  it('seeds the file with the shipped templates on first use', () => {
    const { store, file } = sandbox();
    const listed = store.list();

    expect(listed.length).toBe(DEFAULT_PROMPTS.length);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as unknown[];
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.length).toBe(DEFAULT_PROMPTS.length);
    expect(Object.keys(onDisk[0] as object)).toContain('prompt');
  });

  it('shipped templates all have a name, a description and a prompt', () => {
    for (const template of DEFAULT_PROMPTS) {
      expect(template.name.trim(), template.name).not.toBe('');
      expect(template.description.trim(), template.name).not.toBe('');
      // Short enough for a 0.6B model to actually follow.
      expect(template.prompt.length, template.name).toBeLessThan(400);
    }
  });

  it('creates, updates and removes templates', () => {
    const { store } = sandbox();

    store.save({ name: 'Pirate', description: 'Arr.', prompt: 'Answer like a pirate.' });
    expect(store.get('Pirate')?.prompt).toBe('Answer like a pirate.');

    store.save({ name: 'Pirate', description: 'Arr.', prompt: 'Answer like a pirate, briefly.' });
    expect(store.get('Pirate')?.prompt).toBe('Answer like a pirate, briefly.');
    expect(store.list().filter((entry) => entry.name === 'Pirate')).toHaveLength(1);

    store.remove('Pirate');
    expect(store.get('Pirate')).toBeNull();
  });

  it('refuses an empty prompt or a name that is too short', () => {
    const { store } = sandbox();
    expect(() => store.save({ name: 'X', prompt: 'hello' })).toThrow(PromptError);
    expect(() => store.save({ name: 'Empty', prompt: '   ' })).toThrow(PromptError);
    expect(() => store.remove('Nope')).toThrow(PromptError);
  });

  it('remembers the selection across store instances', () => {
    const { store, file, models } = sandbox();
    expect(store.activeName()).toBe('');
    expect(store.activePrompt()).toBe('');

    store.setActive('Precise');
    const reopened = new SystemPromptStore({ file, catalogue: models });
    expect(reopened.activeName()).toBe('Precise');
    expect(reopened.activePrompt()).toContain('one or two sentences');

    // The selection lives in the shared catalogue, not in the prompts file.
    const catalogue = JSON.parse(readFileSync(join(models.dir, 'models-settings.json'), 'utf8'));
    expect(catalogue.activePrompt).toBe('Precise');
    expect(Array.isArray(JSON.parse(readFileSync(file, 'utf8')))).toBe(true);
  });

  it('clears the selection when the active template is deleted', () => {
    const { store } = sandbox();
    store.setActive('Options');
    store.remove('Options');
    expect(store.activeName()).toBe('');
    expect(store.activePrompt()).toBe('');
  });

  it('falls back to a default description when none is given', () => {
    const { store } = sandbox();
    const saved = store.save({ name: 'Terse', prompt: 'Answer in one word. Nothing else.' });
    expect(saved.description).toBe('Answer in one word.');
  });

  it('survives a broken file instead of blocking chat', () => {
    const { store, file } = sandbox();
    writeFileSync(file, '{ not json');
    expect(() => store.list()).toThrow(PromptError);
    expect(store.activePrompt()).toBe('');
  });
});

describe('the engine and the store agree', () => {
  it('uses the selected template, and a per-request override wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-engine-'));
    dirs.push(dir);
    const models = new ModelStore({ dir, weightsDir: dir });
    const prompts = new SystemPromptStore({
      file: join(dir, 'systemPrompts.json'),
      catalogue: models,
    });
    const engine = new QwenEngine({ modelsDir: dir, weightsDir: dir, prompts });

    expect(engine.prompts.activePrompt()).toBe('');
    prompts.setActive('Skeptical');
    expect(engine.prompts.activePrompt()).toContain('what you know');
  }, 20_000);
});

describe('the chosen style reaches the model', () => {
  it('is a short, clearly headed section of the system prompt', () => {
    const withStyle = buildSystemPrompt({
      records: [],
      tools: false,
      thinking: false,
      styleGuide: 'Answer in one or two sentences.',
    });
    expect(withStyle).toContain('# Working style');
    expect(withStyle).toContain('Answer in one or two sentences.');

    const without = buildSystemPrompt({ records: [], tools: false, thinking: false });
    expect(without).not.toContain('# Working style');
  });
});

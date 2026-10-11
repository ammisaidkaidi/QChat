import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ModelStore, PROJECT_ROOT } from '../src/chat/modelStore.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'infagent-models-'));
}

describe('ModelStore', () => {
  it('defaults to the project models folder for settings, cache for weights', () => {
    const store = new ModelStore({});
    expect(store.dir.replace(/\/$/, '')).toBe(join(PROJECT_ROOT, 'models'));
    expect(store.weightsDir).toContain(join('.cache', 'infagent', 'models'));
  });

  it('finds weights in the cache when they are not beside the settings', () => {
    const settingsDir = scratch();
    const weightsDir = scratch();
    const store = new ModelStore({ dir: settingsDir, weightsDir });
    store.writeSettings(store.defaultSettings('cached', 'cached.gguf'));
    writeFileSync(join(weightsDir, 'cached.gguf'), 'weights in a cache');

    const record = store.get('cached');
    expect(record?.present).toBe(true);
    expect(record?.path).toBe(join(weightsDir, 'cached.gguf'));
    expect(store.list()).toHaveLength(1);
  });

  it('adopts a GGUF dropped into the folder and writes its settings', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'Mystery-Model-Q4_K_M.gguf'), 'not really a model');

    const models = new ModelStore({ dir, weightsDir: dir }).list();
    expect(models).toHaveLength(1);
    expect(models[0]?.settings.id).toBe('Mystery-Model-Q4_K_M');
    expect(models[0]?.settings.name).toBe('Mystery-Model-Q4_K_M');
    expect(models[0]?.present).toBe(true);
    expect(models[0]?.active).toBe(true);

    const written = JSON.parse(
      readFileSync(join(dir, 'Mystery-Model-Q4_K_M.settings.json'), 'utf8'),
    ) as { version: string; file: string };
    expect(written.version).toBe('infagent-model/v1');
    expect(written.file).toBe('Mystery-Model-Q4_K_M.gguf');
  });

  it('honours the catalogue order and the active model', () => {
    const dir = scratch();
    const store = new ModelStore({ dir, weightsDir: dir });
    store.writeSettings(
      store.defaultSettings('alpha', 'alpha.gguf', { name: 'Alpha', sizeBytes: 10 }),
    );
    store.writeSettings(
      store.defaultSettings('beta', 'beta.gguf', { name: 'Beta', sizeBytes: 20 }),
    );
    store.setActive('beta');

    const listed = store.list();
    expect(listed.map((model) => model.settings.id)).toEqual(['beta', 'alpha']);
    expect(listed.map((model) => model.active)).toEqual([true, false]);
    expect(store.active()?.settings.name).toBe('Beta');
  });

  it('reports missing weights and falls back to a downloadable model', () => {
    const dir = scratch();
    const store = new ModelStore({ dir, weightsDir: dir });
    store.writeSettings(
      store.defaultSettings('missing', 'missing.gguf', {
        source: { url: 'https://example.test/missing.gguf' },
      }),
    );
    store.writeSettings(store.defaultSettings('here', 'here.gguf'));
    writeFileSync(join(dir, 'here.gguf'), 'weights');

    store.setActive('missing');
    // The catalogue still lists both, but the ready-to-run one is effective.
    expect(store.setActive('missing').settings.id).toBe('missing');
    const models = store.list();
    expect(models.find((model) => model.settings.id === 'missing')?.present).toBe(false);
    expect(models.find((model) => model.settings.id === 'here')?.active).toBe(true);
  });

  it('exposes resolved runtime settings with env overrides', () => {
    const dir = scratch();
    const store = new ModelStore({ dir, weightsDir: dir });
    store.writeSettings(
      store.defaultSettings('tuned', 'tuned.gguf', {
        contextSize: 4096,
        threads: 6,
        temperature: 0.2,
        maxTokens: 256,
        chatWrapper: 'qwen',
      }),
    );

    const context = store.activeContext();
    expect(context).toMatchObject({
      id: 'tuned',
      contextSize: 4096,
      threads: 6,
      temperature: 0.2,
      maxTokens: 256,
      chatWrapper: 'qwen',
    });

    const previous = process.env['INFAGENT_LLM_CONTEXT'];
    process.env['INFAGENT_LLM_CONTEXT'] = '1024';
    expect(new ModelStore({ dir, weightsDir: dir }).activeContext().contextSize).toBe(1024);
    if (previous === undefined) delete process.env['INFAGENT_LLM_CONTEXT'];
    else process.env['INFAGENT_LLM_CONTEXT'] = previous;
  });

  it('throws for an unknown model id', () => {
    const store = new ModelStore({ dir: scratch(), weightsDir: scratch() });
    expect(() => store.setActive('nope')).toThrow(/Unknown model/);
  });
});

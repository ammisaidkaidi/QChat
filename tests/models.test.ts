import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ModelStore, PROJECT_ROOT } from '../src/chat/modelStore.js';
import { QwenEngine } from '../src/chat/qwen.js';

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

  it('keeps a selected model active even before its weights are downloaded', () => {
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
    const models = store.list();
    expect(store.active()?.settings.id).toBe('missing');
    const missing = models.find((model) => model.settings.id === 'missing');
    expect(missing?.present).toBe(false);
    expect(missing?.active).toBe(true);
    // The download source survives the switch, which is what the console turns
    // into "not downloaded" plus a working Download button.
    expect(missing?.settings.source?.url).toBe('https://example.test/missing.gguf');
  });

  it('falls back to a model that is on disk when the catalogue entry is gone', () => {
    const dir = scratch();
    const store = new ModelStore({ dir, weightsDir: dir });
    store.writeSettings(
      store.defaultSettings('missing', 'missing.gguf', {
        source: { url: 'https://example.test/missing.gguf' },
      }),
    );
    store.writeSettings(store.defaultSettings('here', 'here.gguf'));
    writeFileSync(join(dir, 'here.gguf'), 'weights');

    // A catalogue pointing at a settings file that no longer exists.
    writeFileSync(
      join(dir, 'models-settings.json'),
      JSON.stringify({ version: 'infagent-models/v1', active: 'deleted', order: [] }),
    );
    const models = store.list();
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

  it('ships the catalogued models with a call convention each', () => {
    // The real `models/` folder, not a scratch dir: this is the shipped list.
    const store = new ModelStore({});
    const models = store.list();
    const byId = new Map(models.map((record) => [record.settings.id, record]));

    for (const id of [
      'Qwen3-0.6B-Q4_K_M',
      'Hammer2.1-3b-Q4_K_M',
      'xLAM-2-3B-fc-r-Q4_K_M',
      'Qwen3-4B-Thinking-2507-Q4_K_M',
      'FunctionGemma-270M-Q4_K_M',
      'Qwen2.5-0.5B-Instruct-Q4_K_M',
      'LFM2.5-350M-Q4_K_M',
      'SmolLM2-360M-Instruct-Q4_K_M',
      'Yantra-1B-Agent-Q4_K_M',
      'Nexus-TinyFunction-1.2B-Q4_K_M',
      'Llama-3.2-1B-Instruct-Q4_K_M',
      'xLAM-1b-fc-r-Q4_K_M',
      'Gemma-3-1B-IT-Q4_K_M',
      'MiniCPM5-1B-Q4_K_M',
    ]) {
      const record = byId.get(id);
      expect(record, `${id} is missing from models/`).toBeDefined();
      expect(record?.settings.source?.url).toMatch(/^https:\/\/huggingface\.co\//);
      expect(record?.settings.sizeBytes).toBeGreaterThan(50_000_000);
    }

    // Every settings file in the folder is catalogued: no orphans, no duplicates.
    const ids = models.map((record) => record.settings.id);
    expect(new Set(ids).size).toBe(ids.length);

    // Hammer2.1 and xLAM answer with a JSON array, Qwen3 with its own tags,
    // everything else uses the ChatML/Hermes convention.
    expect(byId.get('Hammer2.1-3b-Q4_K_M')?.settings.style).toBe('xlam');
    expect(byId.get('xLAM-2-3B-fc-r-Q4_K_M')?.settings.style).toBe('xlam');
    expect(byId.get('xLAM-1b-fc-r-Q4_K_M')?.settings.style).toBe('xlam');
    expect(byId.get('Qwen3-4B-Thinking-2507-Q4_K_M')?.settings.style).toBe('qwen3');
    expect(byId.get('Qwen3-4B-Thinking-2507-Q4_K_M')?.settings.thinking).toBe(true);
    for (const id of ['FunctionGemma-270M-Q4_K_M', 'LFM2.5-350M-Q4_K_M', 'Gemma-3-1B-IT-Q4_K_M']) {
      expect(byId.get(id)?.settings.style).toBe('plain');
    }

    // The settings files on disk parse and carry their own id.
    for (const record of models) {
      const raw = JSON.parse(readFileSync(record.settingsPath, 'utf8')) as { id: string };
      expect(raw.id).toBe(record.settings.id);
    }
  });

  it('keeps a chat-selected model in memory without changing the global default', () => {
    const dir = scratch();
    const store = new ModelStore({ dir, weightsDir: scratch() });
    store.writeSettings(store.defaultSettings('default-model', 'default.gguf'));
    store.writeSettings(store.defaultSettings('chat-model', 'chat.gguf'));
    store.setActive('default-model');

    store.selectActive('chat-model', false);
    expect(store.activeContext().id).toBe('chat-model');
    expect(store.list().find((record) => record.active)?.settings.id).toBe('chat-model');
    expect(store.defaultActive()?.settings.id).toBe('default-model');
    expect(JSON.parse(readFileSync(join(dir, 'models-settings.json'), 'utf8'))).toMatchObject({
      active: 'default-model',
    });
  });

  it('keeps the Qwen engine chat model separate from the global default', async () => {
    const dir = scratch();
    const weightsDir = scratch();
    const store = new ModelStore({ dir, weightsDir });
    store.writeSettings(store.defaultSettings('base-model', 'base.gguf'));
    store.writeSettings(store.defaultSettings('chat-model', 'chat.gguf'));
    store.setActive('base-model');

    const engine = new QwenEngine({ modelsDir: dir, weightsDir });
    await engine.useModel('chat-model', { persist: false });
    expect(engine.models()).toMatchObject({ active: 'chat-model', defaultActive: 'base-model' });
    expect(engine.status().modelId).toBe('chat-model');
    expect(JSON.parse(readFileSync(join(dir, 'models-settings.json'), 'utf8'))).toMatchObject({
      active: 'base-model',
    });
    await engine.unload();
  });

  it('throws for an unknown model id', () => {
    const store = new ModelStore({ dir: scratch(), weightsDir: scratch() });
    expect(() => store.setActive('nope')).toThrow(/Unknown model/);
  });
});

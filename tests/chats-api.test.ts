/** `/api/chats`: SQLite chat history, per-chat settings, and one-time import. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { QwenEngine } from '../src/chat/qwen.js';
import { McpManager } from '../src/mcp/manager.js';
import { ScriptRegistry } from '../src/scripts/registry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { createServer } from '../src/server/server.js';
import type { ChatSettings, StoredChatTurn } from '../src/server/chatStore.js';

interface Harness {
  directory: string;
  url: string;
  server: Server;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    await harness.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

async function start(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'infagent-chats-api-'));
  const scripts = join(directory, 'scripts');
  const skills = join(directory, 'skills');
  const models = join(directory, 'models');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(skills, { recursive: true });
  mkdirSync(models, { recursive: true });
  const mcpConfig = join(directory, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ servers: {} }), 'utf8');

  const registry = new ScriptRegistry({ root: scripts });
  const skillRegistry = new SkillRegistry({ root: skills });
  const mcp = new McpManager({ configPath: mcpConfig });
  const engine = new QwenEngine({
    registry,
    skills: skillRegistry,
    mcp,
    modelsDir: models,
    weightsDir: join(directory, 'weights'),
    idleUnloadMs: 1_000_000,
  });
  const server = createServer({
    registry,
    skills: skillRegistry,
    mcp,
    engine,
    chatDbPath: join(directory, 'data', 'chats.sqlite'),
    uiDir: join(directory, 'ui'),
    envFile: join(directory, '.env'),
    envReference: join(directory, '.env.example'),
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port.');
  const harness: Harness = {
    directory,
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: async () => {
      await mcp.stopAll();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  harnesses.push(harness);
  return harness;
}

async function call(
  harness: Harness,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${harness.url}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const settings: ChatSettings = {
  temperature: 0.8,
  maxTokens: 900,
  thinking: true,
  tools: false,
  net: false,
  systemPrompt: 'Be brief.',
  maxSteps: 2,
  mcpServers: ['filesystem'],
  modelId: 'Qwen3-0.6B-Q4_K_M',
  styleName: 'Precise',
};

const turns: StoredChatTurn[] = [
  {
    id: 'u1',
    role: 'user',
    text: 'Read the file',
    thinking: '',
    calls: [],
    skills: ['repo-search'],
  },
  {
    id: 'a1',
    role: 'assistant',
    text: 'It has one line.',
    thinking: 'Check the result.',
    calls: [{ name: 'filesystem__read_file', args: { path: 'a.txt' }, ok: true, result: 'hello' }],
    plans: [{ text: 'Read it', step: 1 }],
    stats: { totalTokens: 30, tokensPerSecond: 10, durationMs: 3000 },
  },
];

describe('chat endpoints', () => {
  it('creates a chat, lists it, and reloads the complete transcript/settings', async () => {
    const harness = await start();
    const created = await call(harness, '/api/chats', {
      method: 'POST',
      body: { title: 'Research', settings, turns },
    });
    expect(created.status).toBe(201);
    const chat = created.body['chat'] as Record<string, unknown>;
    const id = chat['id'] as string;
    expect(chat).toMatchObject({ title: 'Research', settings, turnCount: 2 });
    expect(chat['turns']).toMatchObject([
      { role: 'user', text: 'Read the file', skills: ['repo-search'] },
      { role: 'assistant', calls: [{ name: 'filesystem__read_file', result: 'hello' }] },
    ]);

    const list = await call(harness, '/api/chats');
    expect(list.status).toBe(200);
    expect(list.body['chats']).toMatchObject([
      {
        id,
        title: 'Research',
        preview: 'It has one line.',
        turnCount: 2,
        modelId: settings.modelId,
      },
    ]);

    const reopened = await call(harness, `/api/chats/${id}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body['chat']).toMatchObject({ settings, turns: chat['turns'] });
  });

  it('updates only the selected chat, per-chat settings and title, and auto-titles from the first turn', async () => {
    const harness = await start();
    const first = await call(harness, '/api/chats', { method: 'POST', body: { settings } });
    const second = await call(harness, '/api/chats', {
      method: 'POST',
      body: { settings: { ...settings, modelId: 'other-model', mcpServers: [] } },
    });
    const firstId = (first.body['chat'] as { id: string }).id;
    const secondId = (second.body['chat'] as { id: string }).id;

    const changed = await call(harness, `/api/chats/${firstId}/settings`, {
      method: 'PUT',
      body: { settings: { ...settings, temperature: 1.2, mcpServers: [] } },
    });
    expect(changed.status).toBe(200);
    expect(changed.body['chat']).toMatchObject({ id: firstId, modelId: settings.modelId });
    expect((await call(harness, `/api/chats/${firstId}`)).body['chat']).toMatchObject({
      settings: { temperature: 1.2, mcpServers: [] },
    });

    const transcript = await call(harness, `/api/chats/${firstId}/turns`, {
      method: 'PUT',
      body: {
        turns: [{ id: 'u', role: 'user', text: 'Summarize this project', thinking: '', calls: [] }],
      },
    });
    expect(transcript.body['chat']).toMatchObject({
      title: 'Summarize this project',
      turnCount: 1,
    });
    const list = await call(harness, '/api/chats');
    expect(list.body['chats']).toMatchObject([
      { id: firstId, title: 'Summarize this project', modelId: settings.modelId },
      { id: secondId, modelId: 'other-model' },
    ]);

    const renamed = await call(harness, `/api/chats/${firstId}`, {
      method: 'PATCH',
      body: { title: 'Project notes' },
    });
    expect(renamed.body['chat']).toMatchObject({ title: 'Project notes' });
  });

  it('imports the legacy browser transcript once and safely retries the same import', async () => {
    const harness = await start();
    const input = {
      importId: '99aabbccddeeff001122334455667788',
      title: 'Imported legacy chat',
      settings,
      turns,
    };
    const first = await call(harness, '/api/chats/import', { method: 'POST', body: input });
    const again = await call(harness, '/api/chats/import', { method: 'POST', body: input });
    expect(first.body).toMatchObject({ created: true, chat: { title: 'Imported legacy chat' } });
    expect(again.body).toEqual({ created: false, chat: first.body['chat'] });
    expect((await call(harness, '/api/chats')).body['chats']).toHaveLength(1);
  });

  it('returns 400 for invalid settings/transcripts and 404 for missing chats', async () => {
    const harness = await start();
    expect(
      await call(harness, '/api/chats', {
        method: 'POST',
        body: { settings: { ...settings, maxSteps: 99 } },
      }),
    ).toMatchObject({ status: 400, body: { error: expect.stringContaining('maxSteps') } });
    const created = await call(harness, '/api/chats', { method: 'POST', body: { settings } });
    const id = (created.body['chat'] as { id: string }).id;
    expect(
      await call(harness, `/api/chats/${id}/turns`, {
        method: 'PUT',
        body: { turns: [{ role: 'system', text: 'no' }] },
      }),
    ).toMatchObject({ status: 400, body: { error: expect.stringContaining('role') } });
    expect(await call(harness, '/api/chats/not-here')).toMatchObject({
      status: 404,
      body: { error: 'Chat not found.' },
    });
  });

  it('deletes just one history item and returns 404 after it is gone', async () => {
    const harness = await start();
    const one = await call(harness, '/api/chats', { method: 'POST', body: { settings } });
    const two = await call(harness, '/api/chats', { method: 'POST', body: { settings } });
    const oneId = (one.body['chat'] as { id: string }).id;
    const twoId = (two.body['chat'] as { id: string }).id;
    expect(await call(harness, `/api/chats/${oneId}`, { method: 'DELETE' })).toMatchObject({
      status: 200,
      body: { deleted: oneId },
    });
    expect((await call(harness, '/api/chats')).body['chats']).toMatchObject([{ id: twoId }]);
    expect(await call(harness, `/api/chats/${oneId}`, { method: 'DELETE' })).toMatchObject({
      status: 404,
    });
    const file = readFileSync(join(harness.directory, 'data', 'chats.sqlite'));
    expect(file.subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
  });
});

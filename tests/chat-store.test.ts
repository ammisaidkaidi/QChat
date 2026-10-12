/** Durable per-chat settings and full conversation turns. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ChatStore,
  ChatStoreError,
  DEFAULT_CHAT_SETTINGS,
  normaliseChatSettings,
  normaliseChatTurns,
} from '../src/server/chatStore.js';

const directories: string[] = [];
const stores: ChatStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function open(): { directory: string; path: string; store: ChatStore } {
  const directory = mkdtempSync(join(tmpdir(), 'infagent-chat-store-'));
  directories.push(directory);
  const path = join(directory, 'data', 'chats.sqlite');
  const store = new ChatStore(path);
  stores.push(store);
  return { directory, path, store };
}

const settings = {
  ...DEFAULT_CHAT_SETTINGS,
  temperature: 0.7,
  maxTokens: 768,
  thinking: true,
  tools: false,
  net: false,
  systemPrompt: 'Be precise.',
  maxSteps: 3,
  mcpServers: ['filesystem', 'fetch'],
  modelId: 'Qwen3-0.6B-Q4_K_M',
  styleName: 'Precise',
};

const fullTurns = [
  {
    id: 'user-1',
    role: 'user',
    text: 'Read this file.',
    thinking: '',
    calls: [],
    skills: ['repo-search'],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    text: 'The file contains two lines.',
    thinking: 'Need inspect it.',
    calls: [
      {
        name: 'filesystem__read_file',
        args: { path: 'README.md' },
        ok: true,
        result: { text: 'hello', lines: 2 },
        durationMs: 17,
      },
    ],
    plans: [{ text: 'Read the file', step: 1 }],
    stats: { totalTokens: 94, tokensPerSecond: 12.5, durationMs: 1400, repairs: 1 },
  },
];

describe('normaliseChatSettings', () => {
  it('fills legacy fields with defaults and preserves per-chat choices', () => {
    expect(normaliseChatSettings({ temperature: 0.9, mcpServers: [] })).toMatchObject({
      ...DEFAULT_CHAT_SETTINGS,
      temperature: 0.9,
      mcpServers: [],
    });
    expect(normaliseChatSettings(settings)).toEqual(settings);
  });

  it.each([
    { temperature: 2.1 },
    { maxTokens: 0 },
    { thinking: 'yes' },
    { tools: 1 },
    { maxSteps: 13 },
    { systemPrompt: 'x'.repeat(40_001) },
    { mcpServers: 'filesystem' },
  ])('refuses invalid values: %o', (value) => {
    expect(() => normaliseChatSettings({ ...DEFAULT_CHAT_SETTINGS, ...value })).toThrow(
      ChatStoreError,
    );
  });
});

describe('normaliseChatTurns', () => {
  it('keeps complete turns but clears an in-progress streaming flag', () => {
    const [user, assistant] = normaliseChatTurns([
      ...fullTurns,
      { id: 'streaming', role: 'assistant', text: '', thinking: '', calls: [], streaming: true },
    ]);
    expect(user).toMatchObject({ role: 'user', skills: ['repo-search'], streaming: false });
    expect(assistant).toMatchObject({
      role: 'assistant',
      thinking: 'Need inspect it.',
      calls: [{ name: 'filesystem__read_file', result: { text: 'hello', lines: 2 } }],
      plans: [{ text: 'Read the file', step: 1 }],
      stats: { repairs: 1 },
      streaming: false,
    });
  });

  it('marks a turn that was saved mid-stream as interrupted when it is reopened', () => {
    expect(
      normaliseChatTurns([
        {
          id: 'partial',
          role: 'assistant',
          text: 'partial reply',
          thinking: '',
          calls: [],
          streaming: true,
        },
      ]),
    ).toMatchObject([
      {
        streaming: false,
        error:
          'Generation was interrupted before this turn finished; its partial stream was not resumed.',
      },
    ]);
  });

  it('rejects malformed turns and oversized lists rather than storing bad history', () => {
    expect(() => normaliseChatTurns([{ role: 'system' }])).toThrow(/unknown role/i);
    expect(() => normaliseChatTurns(Array.from({ length: 10_001 }, () => ({})))).toThrow(
      /no more than/i,
    );
  });
});

describe('ChatStore', () => {
  it('writes a full conversation and per-chat settings into a durable SQLite database', () => {
    const { path, store } = open();
    const chat = store.create({ title: 'Database check', settings, turns: fullTurns });
    expect(existsSync(path)).toBe(true);
    expect(chat.settings).toEqual(settings);
    expect(chat.turns).toEqual(normaliseChatTurns(fullTurns));
    expect(chat.turnCount).toBe(2);
    expect(chat.preview).toBe('The file contains two lines.');
    expect(chat.modelId).toBe(settings.modelId);

    const header = readFileSync(path).subarray(0, 16).toString('utf8');
    expect(header).toBe('SQLite format 3\u0000');
  });

  it('survives closing and reopening the server store', () => {
    const { path, store } = open();
    const created = store.create({ title: 'Durable', settings, turns: fullTurns });
    stores.splice(stores.indexOf(store), 1);
    store.close();

    const reopened = new ChatStore(path);
    stores.push(reopened);
    expect(reopened.get(created.id)).toMatchObject({
      title: 'Durable',
      settings,
      turns: normaliseChatTurns(fullTurns),
    });
  });

  it('sorts by latest activity and makes the first user message the default title', () => {
    const { store } = open();
    const older = store.create({ settings });
    const newer = store.create({ settings });
    store.saveTurns(older.id, [
      { id: 'u', role: 'user', text: 'Find the note in the project', thinking: '', calls: [] },
    ]);
    const list = store.list();
    expect(list.map((chat) => chat.id)).toEqual([older.id, newer.id]);
    expect(list[0]?.title).toBe('Find the note in the project');
    expect(list[0]?.preview).toBe('Find the note in the project');
  });

  it('updates settings and title independently from the transcript', () => {
    const { store } = open();
    const created = store.create({ settings });
    store.updateSettings(created.id, { ...settings, temperature: 1.1, mcpServers: [] });
    store.updateTitle(created.id, 'Renamed');
    expect(store.get(created.id)).toMatchObject({
      title: 'Renamed',
      settings: { ...settings, temperature: 1.1, mcpServers: [] },
      turns: [],
    });
  });

  it('deletes only the chosen chat and cascades its settings and turns', () => {
    const { store } = open();
    const keep = store.create({ settings, turns: fullTurns });
    const remove = store.create({ settings, turns: fullTurns });
    expect(store.delete(remove.id)).toBe(true);
    expect(store.delete(remove.id)).toBe(false);
    expect(store.get(remove.id)).toBeNull();
    expect(store.get(keep.id)?.turns).toHaveLength(2);
  });

  it('imports legacy localStorage exactly once using its stable migration id', () => {
    const { store } = open();
    const input = {
      importId: '0123456789abcdef0123456789abcdef',
      title: 'Imported',
      settings,
      turns: fullTurns,
    };
    const first = store.importLegacy(input);
    const duplicate = store.importLegacy(input);
    expect(first.created).toBe(true);
    expect(first.chat?.turns).toHaveLength(2);
    expect(duplicate).toEqual({ chat: first.chat, created: false });
    expect(store.list()).toHaveLength(1);
  });

  it('remembers that a deleted legacy import was already migrated', () => {
    const { store } = open();
    const input = {
      importId: 'fedcba9876543210fedcba9876543210',
      settings,
      turns: [],
    };
    const first = store.importLegacy(input);
    expect(first.chat).not.toBeNull();
    store.delete(first.chat!.id);
    expect(store.importLegacy(input)).toEqual({ chat: null, created: false });
    expect(store.list()).toEqual([]);
  });

  it('refuses a bad migration token and returns null for an unknown chat', () => {
    const { store } = open();
    expect(() => store.importLegacy({ importId: 'not-random', settings, turns: [] })).toThrow(
      /character token/i,
    );
    expect(store.get('missing')).toBeNull();
    expect(store.updateSettings('missing', settings)).toBeNull();
    expect(store.saveTurns('missing', [])).toBeNull();
  });
});

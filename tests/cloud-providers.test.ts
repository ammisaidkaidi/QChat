/** Cloud provider persistence, compatibility adapters, and server routes. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CloudInference,
  CloudProviderError,
  CloudProviderStore,
  CLOUD_PROVIDER_PRESETS,
  cloudApiKeyEnvName,
} from '../src/cloud/providers.js';
import { QwenEngine } from '../src/chat/qwen.js';
import { McpManager } from '../src/mcp/manager.js';
import { ScriptRegistry } from '../src/scripts/registry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { createServer } from '../src/server/server.js';

interface Harness {
  directory: string;
  url: string;
  server: Server;
  envFile: string;
  providerStore: CloudProviderStore;
  close: () => Promise<void>;
}

const temporaryDirectories: string[] = [];
const harnesses: Harness[] = [];
const originalEnvironment = new Map<string, string | undefined>();

function temporaryDirectory(prefix = 'infagent-cloud-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    await harness.close();
  }
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnvironment.clear();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function responseStream(text: string, contentType = 'text/event-stream'): Response {
  return new Response(text, { status: 200, headers: { 'content-type': contentType } });
}

function configuredStore(
  directory: string,
  adapter: 'openai-compatible' | 'anthropic' | 'gemini',
  baseUrl: string,
  modelId: string,
): CloudProviderStore {
  const store = new CloudProviderStore(join(directory, 'provider-data', 'cloud-providers.json'));
  store.upsert({
    id: 'provider-test',
    name: 'Test provider',
    adapter,
    baseUrl,
    models: [{ id: modelId, name: 'Test model' }],
  });
  return store;
}

async function readEvents(
  inference: CloudInference,
  providerId = 'provider-test',
  modelId = 'test-model',
): Promise<{ type: string; text?: string }[]> {
  const events: { type: string; text?: string }[] = [];
  for await (const event of inference.stream({
    providerId,
    modelId,
    messages: [{ role: 'user', content: 'Say hello.' }],
    temperature: 0.2,
    maxTokens: 48,
  })) {
    events.push(event);
  }
  return events;
}

function openAiSse(text = 'Hello from cloud'): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content: text } }] });
  return responseStream(`data: ${chunk}\n\ndata: [DONE]\n\n`);
}

async function startServerWithCloud(fetcher: typeof fetch): Promise<Harness> {
  const directory = temporaryDirectory('infagent-cloud-api-');
  const scripts = join(directory, 'scripts');
  const skills = join(directory, 'skills');
  const models = join(directory, 'models');
  const mcpConfig = join(directory, 'mcp.json');
  const envFile = join(directory, '.env');
  const providerStore = new CloudProviderStore(join(directory, 'app-data', 'cloud-providers.json'));
  for (const path of [scripts, skills, models]) mkdirSync(path, { recursive: true });
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
  const inference = new CloudInference(
    providerStore,
    (provider) => process.env[cloudApiKeyEnvName(provider.id)] ?? null,
    fetcher,
  );
  const server = createServer({
    registry,
    skills: skillRegistry,
    mcp,
    engine,
    chatDbPath: join(directory, 'app-data', 'chats.sqlite'),
    cloudProviders: providerStore,
    cloudInference: inference,
    uiDir: join(directory, 'ui'),
    envFile,
    envReference: join(directory, '.env.example'),
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port.');
  const harness: Harness = {
    directory,
    url: `http://127.0.0.1:${address.port}`,
    server,
    envFile,
    providerStore,
    close: async () => {
      await mcp.stopAll();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  harnesses.push(harness);
  return harness;
}

async function apiCall(
  harness: Harness,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(`${harness.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    raw,
  };
}

describe('cloud provider store and adapters', () => {
  it('stores provider metadata outside chat history and validates secure endpoint URLs', () => {
    const directory = temporaryDirectory();
    const store = new CloudProviderStore(join(directory, 'private', 'providers.json'));
    const provider = store.upsert({
      id: 'nvidia-nim',
      name: 'NVIDIA NIM',
      adapter: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1/',
      models: ['meta/llama-3.1-8b-instruct'],
      apiKey: 'must-not-persist-here',
    });

    expect(provider.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(store.list()).toMatchObject([
      { id: 'nvidia-nim', models: [{ id: 'meta/llama-3.1-8b-instruct' }] },
    ]);
    expect(readFileSync(store.path, 'utf8')).not.toContain('must-not-persist-here');
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, 'private')).mode & 0o777).toBe(0o700);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    }
    expect(() =>
      store.upsert({
        id: 'bad-http',
        name: 'Bad HTTP',
        adapter: 'openai-compatible',
        baseUrl: 'http://api.example.com',
        models: [],
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      store.upsert({
        id: 'local-http',
        name: 'Local',
        adapter: 'openai-compatible',
        baseUrl: 'http://localhost:1234/v1',
        models: [],
      }),
    ).not.toThrow();
    expect(CLOUD_PROVIDER_PRESETS.map((preset) => preset.id)).toContain('nvidia-nim');
  });

  it('uses OpenAI-compatible streaming and redacts API keys from provider errors', async () => {
    const directory = temporaryDirectory();
    const store = configuredStore(
      directory,
      'openai-compatible',
      'https://nim.example/v1',
      'test-model',
    );
    let requestedUrl = '';
    let authorization = '';
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return openAiSse();
    };
    const inference = new CloudInference(store, () => 'super-secret', fetcher);
    const events = await readEvents(inference);
    expect(requestedUrl).toBe('https://nim.example/v1/chat/completions');
    expect(authorization).toBe('Bearer super-secret');
    expect(events).toContainEqual({ type: 'token', text: 'Hello from cloud' });
    expect(events.at(-1)).toEqual({ type: 'done' });

    const failing = new CloudInference(
      store,
      () => 'super-secret',
      async () =>
        responseStream(
          `data: ${JSON.stringify({ error: { message: 'rejected super-secret key' } })}\n\n`,
        ),
    );
    await expect(readEvents(failing)).rejects.toThrow('rejected [redacted] key');
  });

  it('uses Anthropic Messages headers, endpoint, and text delta events', async () => {
    const directory = temporaryDirectory();
    const store = configuredStore(
      directory,
      'anthropic',
      'https://api.anthropic.com',
      'claude-test',
    );
    let requestedUrl = '';
    let headers = new Headers();
    let body: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      headers = new Headers(init?.headers);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseStream(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi Anthropic"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      );
    };
    const inference = new CloudInference(store, () => 'anthropic-secret', fetcher);
    const events = await readEvents(inference, 'provider-test', 'claude-test');
    expect(requestedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(headers.get('x-api-key')).toBe('anthropic-secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(body['stream']).toBe(true);
    expect(events).toContainEqual({ type: 'token', text: 'Hi Anthropic' });
  });

  it('uses Gemini model streaming and sends its API key in a header', async () => {
    const directory = temporaryDirectory();
    const store = configuredStore(
      directory,
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini-2.5-flash',
    );
    let requestedUrl = '';
    let headers = new Headers();
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      headers = new Headers(init?.headers);
      return responseStream(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi Gemini' }] } }], usageMetadata: { candidatesTokenCount: 4 } })}\n\n`,
      );
    };
    const inference = new CloudInference(store, () => 'gemini-secret', fetcher);
    const events = await readEvents(inference, 'provider-test', 'gemini-2.5-flash');
    expect(requestedUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
    expect(headers.get('x-goog-api-key')).toBe('gemini-secret');
    expect(requestedUrl).not.toContain('gemini-secret');
    expect(events).toContainEqual({ type: 'token', text: 'Hi Gemini' });
  });

  it('rejects an unconfigured model before making an upstream request', async () => {
    const directory = temporaryDirectory();
    const store = configuredStore(
      directory,
      'openai-compatible',
      'https://nim.example/v1',
      'one-model',
    );
    const fetcher = vi.fn<typeof fetch>(async () => openAiSse());
    const inference = new CloudInference(store, () => 'test-key', fetcher);
    await expect(readEvents(inference, 'provider-test', 'another-model')).rejects.toBeInstanceOf(
      CloudProviderError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('cloud provider API and cloud chat route', () => {
  it('keeps keys write-only in the API, tests models, streams a cloud chat, and removes the key', async () => {
    const keyName = cloudApiKeyEnvName('nvidia-nim');
    if (!originalEnvironment.has(keyName)) originalEnvironment.set(keyName, process.env[keyName]);
    delete process.env[keyName];
    const upstreamCalls: { url: string; method: string; authorization: string; body: string }[] =
      [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      const method = init?.method ?? 'GET';
      upstreamCalls.push({
        url,
        method,
        authorization: headers.get('authorization') ?? '',
        body: String(init?.body ?? ''),
      });
      if (method === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'meta/llama-3.1-8b-instruct' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return openAiSse('Cloud says hello');
    };
    const harness = await startServerWithCloud(fetcher);

    const initial = await apiCall(harness, '/api/cloud/providers');
    expect(initial.status).toBe(200);
    expect((initial.body['presets'] as Record<string, unknown>[])[0]).toMatchObject({
      id: 'nvidia-nim',
      adapter: 'openai-compatible',
    });

    const saved = await apiCall(harness, '/api/cloud/providers', 'POST', {
      id: 'nvidia-nim',
      name: 'NVIDIA NIM',
      adapter: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      models: [],
      apiKey: 'nim-test-secret',
    });
    expect(saved.status).toBe(201);
    expect(saved.body['provider']).toMatchObject({ id: 'nvidia-nim', keyConfigured: true });
    expect(saved.raw).not.toContain('nim-test-secret');
    expect(readFileSync(harness.envFile, 'utf8')).toContain(`${keyName}=nim-test-secret`);
    if (process.platform !== 'win32') expect(statSync(harness.envFile).mode & 0o777).toBe(0o600);

    const tested = await apiCall(harness, '/api/cloud/providers/nvidia-nim/test', 'POST', {});
    expect(tested.status).toBe(200);
    expect(tested.body['models']).toEqual([
      { id: 'meta/llama-3.1-8b-instruct', name: 'meta/llama-3.1-8b-instruct' },
    ]);

    const chatResponse = await fetch(`${harness.url}/api/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelSource: 'cloud',
        providerId: 'nvidia-nim',
        modelId: 'meta/llama-3.1-8b-instruct',
        messages: [{ role: 'user', content: 'Say hello.' }],
        temperature: 0.3,
        maxTokens: 64,
        tools: true,
        net: true,
      }),
    });
    const chatSse = await chatResponse.text();
    expect(chatResponse.status).toBe(200);
    expect(chatSse).toContain('event: token');
    expect(chatSse).toContain('Cloud says hello');
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      'https://integrate.api.nvidia.com/v1/models',
      'https://integrate.api.nvidia.com/v1/chat/completions',
    ]);
    expect(upstreamCalls.every((call) => call.authorization === 'Bearer nim-test-secret')).toBe(
      true,
    );

    const deleted = await apiCall(harness, '/api/cloud/providers/nvidia-nim', 'DELETE');
    expect(deleted.status).toBe(200);
    expect(existsSync(harness.envFile) ? readFileSync(harness.envFile, 'utf8') : '').not.toContain(
      keyName,
    );
    expect(process.env[keyName]).toBeUndefined();
    expect((await apiCall(harness, '/api/cloud/providers')).body['providers']).toEqual([]);
  });

  it('rejects provider URLs with credentials and never leaks invalid key values', async () => {
    const emptyFetcher: typeof fetch = async () => {
      throw new Error('must not be called');
    };
    const keyName = cloudApiKeyEnvName('bad-provider');
    if (!originalEnvironment.has(keyName)) originalEnvironment.set(keyName, process.env[keyName]);
    delete process.env[keyName];
    const harness = await startServerWithCloud(emptyFetcher);
    const invalid = await apiCall(harness, '/api/cloud/providers', 'POST', {
      id: 'bad-provider',
      name: 'Bad URL',
      adapter: 'openai-compatible',
      baseUrl: 'https://user:password@example.com/v1',
      models: [],
      apiKey: 'never-return-this-key',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.raw).not.toContain('never-return-this-key');
    expect(harness.providerStore.list()).toEqual([]);
  });
});

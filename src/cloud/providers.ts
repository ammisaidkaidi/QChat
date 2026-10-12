/**
 * Cloud inference providers. Provider metadata is stored separately from chat
 * history; API keys stay in the local .env file and are never returned by this
 * module or written to SQLite.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';

import type { ChatEvent, ChatMessage } from '../chat/types.js';
import { defaultChatDatabasePath } from '../server/chatStore.js';

export type CloudAdapter = 'openai-compatible' | 'anthropic' | 'gemini';

export interface CloudModel {
  id: string;
  name: string;
}

export interface CloudProvider {
  id: string;
  name: string;
  adapter: CloudAdapter;
  /** API root, not a model-specific endpoint. */
  baseUrl: string;
  models: CloudModel[];
  updatedAt: string;
}

export interface CloudProviderPreset {
  id: string;
  name: string;
  adapter: CloudAdapter;
  baseUrl: string;
}

export const CLOUD_PROVIDER_PRESETS: readonly CloudProviderPreset[] = [
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    adapter: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'custom-openai',
    name: 'Custom OpenAI-compatible API',
    adapter: 'openai-compatible',
    baseUrl: '',
  },
];

export class CloudProviderError extends Error {
  public readonly status: 400 | 404 | 409 | 502 | 504;

  constructor(status: 400 | 404 | 409 | 502 | 504, message: string) {
    super(message);
    this.name = 'CloudProviderError';
    this.status = status;
  }
}

interface ProviderFile {
  version: 1;
  providers: CloudProvider[];
}

export interface CloudCompletionRequest {
  providerId: string;
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  promptTemplate?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new CloudProviderError(
      400,
      `Provider ${name} must be a non-empty string (max ${max} characters).`,
    );
  }
  return value.trim();
}

function normaliseAdapter(value: unknown): CloudAdapter {
  if (value === 'openai-compatible' || value === 'anthropic' || value === 'gemini') return value;
  throw new CloudProviderError(
    400,
    'Provider adapter must be openai-compatible, anthropic, or gemini.',
  );
}

function normaliseBaseUrl(value: unknown): string {
  const input = requiredString(value, 'base URL', 512);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new CloudProviderError(400, 'Provider base URL must be a valid HTTP or HTTPS URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new CloudProviderError(
      400,
      'Provider URLs must use HTTPS; HTTP is allowed only for localhost.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CloudProviderError(
      400,
      'Provider base URLs cannot contain credentials, query parameters, or a fragment.',
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normaliseModels(value: unknown, optional = false): CloudModel[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.length > 300) {
    throw new CloudProviderError(400, 'Provider models must be a list of at most 300 model IDs.');
  }
  const byId = new Map<string, CloudModel>();
  for (const item of value) {
    const id = typeof item === 'string' ? item.trim() : isObject(item) ? item['id'] : undefined;
    const name = isObject(item) && typeof item['name'] === 'string' ? item['name'].trim() : '';
    if (typeof id !== 'string' || !id.trim() || id.length > 256) {
      throw new CloudProviderError(400, 'Each provider model needs an ID (max 256 characters).');
    }
    const cleanId = id.trim();
    byId.set(cleanId, { id: cleanId, name: (name || cleanId).slice(0, 160) });
  }
  return [...byId.values()];
}

function normaliseProvider(value: unknown, previous?: CloudProvider): CloudProvider {
  if (!isObject(value))
    throw new CloudProviderError(400, 'Provider configuration must be a JSON object.');
  const id = requiredString(value['id'], 'ID', 48).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
    throw new CloudProviderError(
      400,
      'Provider ID must use lowercase letters, digits, and hyphens.',
    );
  }
  const name = requiredString(value['name'], 'name', 80);
  const adapter = normaliseAdapter(value['adapter']);
  const baseUrl = normaliseBaseUrl(value['baseUrl']);
  const models = normaliseModels(value['models'], value['models'] === undefined);
  return {
    id,
    name,
    adapter,
    baseUrl,
    models: value['models'] === undefined ? (previous?.models ?? []) : models,
    updatedAt: new Date().toISOString(),
  };
}

export function cloudApiKeyEnvName(providerId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(providerId)) {
    throw new CloudProviderError(400, 'Invalid cloud provider ID.');
  }
  return `INFAGENT_CLOUD_${providerId.replace(/-/g, '_').toUpperCase()}_API_KEY`;
}

export function defaultCloudProvidersPath(): string {
  const configured = process.env['INFAGENT_CLOUD_PROVIDERS_PATH']?.trim();
  if (configured) return resolve(configured);
  return join(dirname(defaultChatDatabasePath()), 'cloud-providers.json');
}

/** Small user-data store for provider endpoints and discovered model IDs. */
export class CloudProviderStore {
  public readonly path: string;

  constructor(path = defaultCloudProvidersPath()) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      if (process.platform !== 'win32') chmodSync(dirname(this.path), 0o700);
    } catch {
      // The app-data directory is still created with restrictive permissions.
    }
  }

  private readFile(): ProviderFile {
    if (!existsSync(this.path)) return { version: 1, providers: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!isObject(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['providers'])) {
        throw new Error('unexpected provider configuration format');
      }
      return {
        version: 1,
        providers: parsed['providers'].map((entry) => normaliseProvider(entry)),
      };
    } catch (error) {
      throw new Error(
        `Could not read cloud provider configuration at ${this.path}: ${error instanceof Error ? error.message : 'invalid JSON'}`,
        { cause: error },
      );
    }
  }

  private writeFile(file: ProviderFile): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
  }

  public list(): CloudProvider[] {
    return this.readFile().providers;
  }

  public get(id: string): CloudProvider | null {
    return this.readFile().providers.find((provider) => provider.id === id) ?? null;
  }

  public upsert(value: unknown): CloudProvider {
    if (!isObject(value))
      throw new CloudProviderError(400, 'Provider configuration must be a JSON object.');
    const id = requiredString(value['id'], 'ID', 48).toLowerCase();
    const current = this.readFile();
    const previous = current.providers.find((provider) => provider.id === id);
    const provider = normaliseProvider(value, previous);
    const next = current.providers.filter((entry) => entry.id !== provider.id);
    next.push(provider);
    this.writeFile({ version: 1, providers: next });
    return provider;
  }

  public setModels(id: string, models: CloudModel[]): CloudProvider {
    const current = this.readFile();
    const index = current.providers.findIndex((provider) => provider.id === id);
    if (index === -1) throw new CloudProviderError(404, `Cloud provider "${id}" was not found.`);
    const previous = current.providers[index];
    if (!previous) throw new CloudProviderError(404, `Cloud provider "${id}" was not found.`);
    const updated: CloudProvider = {
      ...previous,
      models: normaliseModels(models),
      updatedAt: new Date().toISOString(),
    };
    current.providers[index] = updated;
    this.writeFile(current);
    return updated;
  }

  public remove(id: string): CloudProvider | null {
    const current = this.readFile();
    const removed = current.providers.find((provider) => provider.id === id) ?? null;
    if (!removed) return null;
    this.writeFile({
      version: 1,
      providers: current.providers.filter((provider) => provider.id !== id),
    });
    return removed;
  }
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_PROVIDER_ERROR_CHARS = 600;

function apiBase(provider: CloudProvider): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  if (provider.adapter === 'anthropic') return /\/v1$/i.test(base) ? base : `${base}/v1`;
  if (provider.adapter === 'gemini' && !/\/v\d+(?:beta|alpha)?$/i.test(base)) {
    return `${base}/v1beta`;
  }
  return base;
}

function authHeaders(
  provider: CloudProvider,
  key: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...extra };
  if (provider.adapter === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.adapter === 'gemini') {
    // The key is sent as a header rather than a URL query parameter.
    headers['x-goog-api-key'] = key;
  } else {
    headers['authorization'] = `Bearer ${key}`;
  }
  return headers;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorMessage(
  response: Response,
  provider: CloudProvider,
  key: string,
): Promise<string> {
  let detail = '';
  try {
    const text = (await response.text()).slice(0, MAX_PROVIDER_ERROR_CHARS * 2);
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) {
          const error = parsed['error'];
          if (typeof error === 'string') detail = error;
          else if (isObject(error) && typeof error['message'] === 'string')
            detail = error['message'];
          else if (typeof parsed['message'] === 'string') detail = parsed['message'];
        }
      } catch {
        detail = text;
      }
    }
  } catch {
    // The status is enough if the provider closed the response body.
  }
  detail = detail
    .replaceAll(key, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  const status =
    response.status === 401 || response.status === 403
      ? `Provider rejected the API key or denied access (HTTP ${response.status}).`
      : `${provider.name} returned HTTP ${response.status}.`;
  return detail ? `${status} ${detail.slice(0, MAX_PROVIDER_ERROR_CHARS)}` : status;
}

async function readProviderJson(
  response: Response,
  provider: CloudProvider,
  key: string,
): Promise<unknown> {
  if (!response.ok) throw new CloudProviderError(502, await errorMessage(response, provider, key));
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CloudProviderError(502, `${provider.name} returned invalid JSON.`);
  }
}

function parseModels(provider: CloudProvider, payload: unknown): CloudModel[] {
  if (!isObject(payload))
    throw new CloudProviderError(502, `${provider.name} returned an invalid model list.`);
  const raw = provider.adapter === 'gemini' ? payload['models'] : payload['data'];
  if (!Array.isArray(raw))
    throw new CloudProviderError(502, `${provider.name} did not return a model list.`);
  const models: CloudModel[] = [];
  for (const row of raw) {
    if (typeof row === 'string') {
      models.push({ id: row, name: row });
      continue;
    }
    if (!isObject(row)) continue;
    const rawId = provider.adapter === 'gemini' ? row['name'] : row['id'];
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    if (provider.adapter === 'gemini') {
      const methods = row['supportedGenerationMethods'];
      if (
        Array.isArray(methods) &&
        methods.every(
          (method) => method !== 'generateContent' && method !== 'streamGenerateContent',
        )
      ) {
        continue;
      }
    }
    const id = provider.adapter === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
    const name =
      (typeof row['display_name'] === 'string' && row['display_name']) ||
      (typeof row['displayName'] === 'string' && row['displayName']) ||
      (typeof row['name'] === 'string' && row['name']) ||
      id;
    models.push({ id: id.slice(0, 256), name: name.slice(0, 160) });
  }
  const unique = new Map(models.map((model) => [model.id, model]));
  return [...unique.values()].slice(0, 300);
}

async function* readSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new CloudProviderError(502, 'Provider did not return a streaming response.');
  const decoder = new TextDecoder();
  let buffer = '';
  const emitFrames = function* (final = false): Generator<{ event: string; data: string }> {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary || boundary.index === undefined) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      yield parseSseFrame(frame);
    }
    if (final && buffer.trim()) {
      yield parseSseFrame(buffer);
      buffer = '';
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* emitFrames();
    }
    buffer += decoder.decode();
    yield* emitFrames(true);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The provider may already have closed the stream.
    }
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): { event: string; data: string } {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data: data.join('\n') };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nestedObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const item = value[key];
  return isObject(item) ? item : null;
}

function safeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    throw new CloudProviderError(400, 'Cloud chat needs 1–10,000 messages.');
  }
  return value.map((message, index) => {
    if (
      !isObject(message) ||
      (message['role'] !== 'system' &&
        message['role'] !== 'user' &&
        message['role'] !== 'assistant') ||
      typeof message['content'] !== 'string' ||
      message['content'].length > 1_000_000
    ) {
      throw new CloudProviderError(400, `Cloud message ${index + 1} is invalid.`);
    }
    return { role: message['role'], content: message['content'] };
  });
}

function systemMessage(input: CloudCompletionRequest, messages: ChatMessage[]): string {
  const systemPrompt = input.systemPrompt ?? '';
  const promptTemplate = input.promptTemplate ?? '';
  if (typeof systemPrompt !== 'string' || typeof promptTemplate !== 'string') {
    throw new CloudProviderError(400, 'Cloud system prompt and template must be strings.');
  }
  const parts = [
    ...messages.filter((message) => message.role === 'system').map((message) => message.content),
    systemPrompt,
    promptTemplate,
  ]
    .map((part) => part.trim())
    .filter(Boolean);
  const combined = parts.join('\n\n');
  if (combined.length > 80_000)
    throw new CloudProviderError(400, 'Cloud system prompt is too long.');
  return combined;
}

function validateCompletion(value: CloudCompletionRequest): {
  modelId: string;
  messages: ChatMessage[];
  system: string;
  temperature: number;
  maxTokens: number;
} {
  const modelId = requiredString(value.modelId, 'model ID', 256);
  const messages = safeMessages(value.messages);
  const temperature = value.temperature ?? 0.4;
  const maxTokens = value.maxTokens ?? 512;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new CloudProviderError(400, 'Cloud temperature must be between 0 and 2.');
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw new CloudProviderError(400, 'Cloud max tokens must be between 1 and 8192.');
  }
  return {
    modelId,
    messages: messages.filter((message) => message.role !== 'system'),
    system: systemMessage(value, messages),
    temperature,
    maxTokens,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Unified chat-completions adapter for OpenAI-compatible, Anthropic, and Gemini APIs. */
export class CloudInference {
  constructor(
    private readonly providers: CloudProviderStore,
    private readonly keyResolver: (provider: CloudProvider) => string | null = (provider) =>
      process.env[cloudApiKeyEnvName(provider.id)] || null,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public apiKeyConfigured(provider: CloudProvider): boolean {
    return Boolean(this.keyResolver(provider)?.trim());
  }

  private providerAndKey(id: string): { provider: CloudProvider; key: string } {
    const provider = this.providers.get(id);
    if (!provider) throw new CloudProviderError(404, `Cloud provider "${id}" was not found.`);
    const key = this.keyResolver(provider)?.trim();
    if (!key)
      throw new CloudProviderError(400, `Set an API key for ${provider.name} in Settings first.`);
    return { provider, key };
  }

  private async request(
    provider: CloudProvider,
    key: string,
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${apiBase(provider)}${path}`;
    try {
      return await this.fetcher(url, {
        ...init,
        headers: {
          ...authHeaders(provider, key),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: requestSignal(signal),
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as Error).name === 'TimeoutError') {
        throw new CloudProviderError(504, `${provider.name} did not respond within 120 seconds.`);
      }
      throw new CloudProviderError(
        502,
        `Could not reach ${provider.name}: ${(error as Error).message}`,
      );
    }
  }

  public async listModels(id: string, signal?: AbortSignal): Promise<CloudModel[]> {
    const { provider, key } = this.providerAndKey(id);
    const response = await this.request(provider, key, '/models', { method: 'GET' }, signal);
    return parseModels(provider, await readProviderJson(response, provider, key));
  }

  public async *stream(
    input: CloudCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const { provider, key } = this.providerAndKey(input.providerId);
    const valid = validateCompletion(input);
    if (!provider.models.some((model) => model.id === valid.modelId)) {
      throw new CloudProviderError(
        400,
        `Model "${valid.modelId}" is not configured for ${provider.name}.`,
      );
    }
    const startedAt = Date.now();
    let outputText = '';
    let providerTotalTokens = 0;

    let response: Response;
    if (provider.adapter === 'anthropic') {
      const messages = valid.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      response = await this.request(
        provider,
        key,
        '/messages',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model: valid.modelId,
            max_tokens: valid.maxTokens,
            temperature: valid.temperature,
            ...(valid.system ? { system: valid.system } : {}),
            messages,
            stream: true,
          }),
        },
        signal,
      );
    } else if (provider.adapter === 'gemini') {
      const model = valid.modelId.replace(/^models\//, '');
      const contents = valid.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
      const body = {
        contents,
        ...(valid.system ? { systemInstruction: { parts: [{ text: valid.system }] } } : {}),
        generationConfig: { temperature: valid.temperature, maxOutputTokens: valid.maxTokens },
      };
      response = await this.request(
        provider,
        key,
        `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
        },
        signal,
      );
    } else {
      const messages = [
        ...(valid.system ? [{ role: 'system', content: valid.system }] : []),
        ...valid.messages.map((message) => ({ role: message.role, content: message.content })),
      ];
      response = await this.request(
        provider,
        key,
        '/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model: valid.modelId,
            messages,
            temperature: valid.temperature,
            max_tokens: valid.maxTokens,
            stream: true,
          }),
        },
        signal,
      );
    }

    if (!response.ok)
      throw new CloudProviderError(502, await errorMessage(response, provider, key));
    if (!response.body)
      throw new CloudProviderError(502, `${provider.name} did not return a response stream.`);
    yield { type: 'status', state: 'ready', detail: `${provider.name} · ${valid.modelId}` };

    for await (const frame of readSse(response, signal)) {
      if (!frame.data || frame.data === '[DONE]') continue;
      let payload: unknown;
      try {
        payload = JSON.parse(frame.data) as unknown;
      } catch {
        continue;
      }
      if (!isObject(payload)) continue;
      if (isObject(payload['error'])) {
        const message = asString((payload['error'] as Record<string, unknown>)['message'])
          .replaceAll(key, '[redacted]')
          .replaceAll(String.fromCharCode(13), ' ')
          .replaceAll(String.fromCharCode(10), ' ')
          .replaceAll(String.fromCharCode(9), ' ')
          .slice(0, MAX_PROVIDER_ERROR_CHARS);
        throw new CloudProviderError(
          502,
          message || `${provider.name} returned a generation error.`,
        );
      }

      if (provider.adapter === 'anthropic') {
        const delta = nestedObject(payload, 'delta');
        if (frame.event === 'content_block_delta' && delta) {
          const type = delta['type'];
          if (type === 'text_delta' && typeof delta['text'] === 'string') {
            outputText += delta['text'];
            yield { type: 'token', text: delta['text'] };
          } else if (type === 'thinking_delta' && typeof delta['thinking'] === 'string') {
            yield { type: 'thinking', text: delta['thinking'] };
          }
        }
        const usage = nestedObject(payload, 'usage') ?? nestedObject(payload, 'message');
        if (usage && typeof usage['output_tokens'] === 'number')
          providerTotalTokens = usage['output_tokens'];
      } else if (provider.adapter === 'gemini') {
        const candidates = payload['candidates'];
        if (Array.isArray(candidates) && isObject(candidates[0])) {
          const content = nestedObject(candidates[0], 'content');
          const parts = content?.['parts'];
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (!isObject(part) || typeof part['text'] !== 'string') continue;
              if (part['thought'] === true) yield { type: 'thinking', text: part['text'] };
              else {
                outputText += part['text'];
                yield { type: 'token', text: part['text'] };
              }
            }
          }
        }
        const usage = nestedObject(payload, 'usageMetadata');
        if (usage && typeof usage['candidatesTokenCount'] === 'number') {
          providerTotalTokens = usage['candidatesTokenCount'];
        }
      } else {
        const choices = payload['choices'];
        if (Array.isArray(choices) && isObject(choices[0])) {
          const delta = nestedObject(choices[0], 'delta');
          if (delta) {
            const reasoning = asString(delta['reasoning_content'] ?? delta['reasoning']);
            if (reasoning) yield { type: 'thinking', text: reasoning };
            const content = delta['content'];
            if (typeof content === 'string' && content) {
              outputText += content;
              yield { type: 'token', text: content };
            } else if (Array.isArray(content)) {
              for (const part of content) {
                if (isObject(part) && typeof part['text'] === 'string') {
                  outputText += part['text'];
                  yield { type: 'token', text: part['text'] };
                }
              }
            }
          }
        }
        const usage = nestedObject(payload, 'usage');
        if (usage && typeof usage['completion_tokens'] === 'number') {
          providerTotalTokens = usage['completion_tokens'];
        }
      }
    }

    const durationMs = Math.max(0, Date.now() - startedAt);
    const totalTokens = providerTotalTokens || estimateTokens(outputText);
    yield {
      type: 'stats',
      totalTokens,
      tokensPerSecond: durationMs > 0 ? totalTokens / (durationMs / 1000) : 0,
      durationMs,
    };
    yield { type: 'done' };
  }
}

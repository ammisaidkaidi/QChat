/**
 * Thin client for the InfAgent API. All paths are relative so the interface
 * works identically when served by `infagent serve` or the Vite dev proxy.
 */
import type {
  AlertRecord,
  ChatConfig,
  EnvRevealAllResult,
  EnvRevealResult,
  EnvSaveResult,
  EnvSnapshot,
  PromptCatalogue,
  McpCatalogue,
  SearchReport,
  SkillDetailFull,
  SkillRecord,
  WebPage,
  ModelCatalog,
  ChatEvent,
  ChatMessage,
  ChatSettings,
  ChatSummary,
  ChatTurn,
  StoredChat,
  CloudProvider,
  CloudProviderPreset,
  CloudModel,
  CreateScriptInput,
  EngineStatus,
  Health,
  ScriptDetail,
  ScriptRecord,
  ScriptRunResult,
  ScriptStats,
  ToolDefinition,
  ToolboxReload,
  ToolboxSaveResult,
  ToolboxSnapshot,
} from './types';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`Unexpected non-JSON response (${response.status}).`);
    }
  }

  if (!response.ok && !(response.status === 422 && payload['result'] !== undefined)) {
    const message =
      typeof payload['error'] === 'string'
        ? payload['error']
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }

  return payload as T;
}

export const alertsApi = {
  list: (limit = 20): Promise<{ count: number; alerts: AlertRecord[] }> =>
    request<{ count: number; alerts: AlertRecord[] }>(`/api/alerts?limit=${limit}`),

  /** Raise an alert in the console from the interface itself. */
  raise: (input: {
    message: string;
    title?: string;
    level?: AlertRecord['level'];
  }): Promise<{
    alert: AlertRecord;
  }> => request<{ alert: AlertRecord }>('/api/alerts', { method: 'POST', body: input }),

  clear: (): Promise<{ removed: number }> =>
    request<{ removed: number }>('/api/alerts', { method: 'DELETE' }),

  /** SSE feed: every alert raised anywhere in the server, live. */
  streamUrl: '/api/alerts/stream',
};

export const api = {
  health: (): Promise<Health> => request<Health>('/api/health'),

  listScripts: (): Promise<{ scripts: ScriptRecord[]; stats: ScriptStats; systemPrompt: string }> =>
    request('/api/scripts'),

  getScript: (name: string): Promise<{ script: ScriptDetail }> =>
    request(`/api/scripts/${encodeURIComponent(name)}`),

  getPrompt: (name: string): Promise<{ prompt: string }> =>
    request(`/api/scripts/${encodeURIComponent(name)}/prompt`),

  createScript: (input: CreateScriptInput): Promise<{ script: ScriptDetail }> =>
    request('/api/scripts', { method: 'POST', body: input }),

  removeScript: (name: string): Promise<{ removed: { name: string; relativePath: string } }> =>
    request(`/api/scripts/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  runScript: (name: string, args: Record<string, unknown>): Promise<{ result: ScriptRunResult }> =>
    request(`/api/scripts/${encodeURIComponent(name)}/run`, { method: 'POST', body: { args } }),

  tools: (): Promise<{ tools: ToolDefinition[]; systemPrompt: string }> => request('/api/tools'),
};

/** Server-side SQLite chat history and the settings attached to each chat. */
export const chatsApi = {
  list: (): Promise<{ chats: ChatSummary[] }> => request('/api/chats'),

  get: (id: string): Promise<{ chat: StoredChat }> =>
    request(`/api/chats/${encodeURIComponent(id)}`),

  create: (input: { title?: string; settings: ChatSettings }): Promise<{ chat: StoredChat }> =>
    request('/api/chats', { method: 'POST', body: input }),

  /** Idempotent migration of the one legacy localStorage transcript. */
  importLegacy: (input: {
    importId: string;
    title?: string;
    settings: ChatSettings;
    turns: ChatTurn[];
  }): Promise<{ chat: StoredChat | null; created: boolean }> =>
    request('/api/chats/import', { method: 'POST', body: input }),

  updateSettings: (id: string, settings: ChatSettings): Promise<{ chat: ChatSummary }> =>
    request(`/api/chats/${encodeURIComponent(id)}/settings`, {
      method: 'PUT',
      body: { settings },
    }),

  saveTurns: (id: string, turns: ChatTurn[]): Promise<{ chat: ChatSummary }> =>
    request(`/api/chats/${encodeURIComponent(id)}/turns`, { method: 'PUT', body: { turns } }),

  rename: (id: string, title: string): Promise<{ chat: ChatSummary }> =>
    request(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { title },
    }),

  remove: (id: string): Promise<{ deleted: string }> =>
    request(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** Provider configuration and connection tests. API keys are write-only. */
export const cloudProvidersApi = {
  list: (): Promise<{ providers: CloudProvider[]; presets: CloudProviderPreset[] }> =>
    request('/api/cloud/providers'),

  save: (input: {
    id: string;
    name: string;
    adapter: CloudProvider['adapter'];
    baseUrl: string;
    models: CloudModel[];
    apiKey?: string;
  }): Promise<{ provider: CloudProvider }> =>
    request('/api/cloud/providers', { method: 'POST', body: input }),

  test: (id: string): Promise<{ provider: CloudProvider; models: CloudModel[] }> =>
    request(`/api/cloud/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }),

  remove: (id: string): Promise<{ removed: string }> =>
    request(`/api/cloud/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** The `.env` file behind the Config tab. */
export const envApi = {
  read: (): Promise<EnvSnapshot> => request<EnvSnapshot>('/api/env'),

  /**
   * Write values. Secret values are never sent back by the server, so an
   * unchanged secret is left alone by simply omitting its key here.
   */
  save: (input: { updates?: Record<string, string>; remove?: string[] }): Promise<EnvSaveResult> =>
    request<EnvSaveResult>('/api/env', { method: 'PUT', body: input }),

  /**
   * The plaintext of one key. The server only sends a value here, so this is
   * called on an explicit click — a snapshot never carries secrets.
   */
  reveal: (key: string): Promise<EnvRevealResult> =>
    request<EnvRevealResult>('/api/env/reveal', { method: 'POST', body: { key } }),

  /** Every credential at once, for the "reveal all" switch. */
  revealAll: (): Promise<EnvRevealAllResult> =>
    request<EnvRevealAllResult>('/api/env/reveal', { method: 'POST', body: { all: true } }),
};

/** System-prompt templates: the "way of thinking" picker. */
export const promptsApi = {
  list: (): Promise<PromptCatalogue> => request<PromptCatalogue>('/api/prompts'),

  save: (input: {
    name: string;
    description?: string;
    prompt: string;
    tags?: string[];
  }): Promise<PromptCatalogue> =>
    request<PromptCatalogue>('/api/prompts', { method: 'POST', body: input }),

  remove: (name: string): Promise<PromptCatalogue> =>
    request<PromptCatalogue>(`/api/prompts/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  select: (name: string): Promise<{ active: string }> =>
    request<{ active: string }>('/api/prompts/active', { method: 'PUT', body: { name } }),
};

/* ── chat: server-sent events ─────────────────────────────────────────────── */

export interface ChatStreamHandle {
  abort: () => void;
}

interface ChatStreamOptions {
  messages: ChatMessage[];
  modelSource?: 'local' | 'cloud';
  providerId?: string;
  /** Per-chat model id; never changes the global model defaults. */
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: boolean;
  tools?: boolean;
  /** Allow webSearch/webFetch for this turn. */
  net?: boolean;
  systemPrompt?: string;
  /** Prompt-template body chosen by this chat, including an explicit empty choice. */
  promptTemplate?: string;
  /** Tool steps allowed in one reply (1–12). */
  maxToolIterations?: number;
  /**
   * MCP servers this turn may use, by name. Omitted = every enabled server;
   * `[]` = none. The engine both hides their tools and refuses their calls.
   */
  mcpServers?: string[];
  /** Skills pinned with `/name` in the box: their bodies load for this turn. */
  skills?: string[];
  onEvent: (event: ChatEvent) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

/**
 * Reads an SSE stream from a POST request. `EventSource` cannot POST, so the
 * response body is parsed frame by frame instead.
 */
export function streamChat(options: ChatStreamOptions): ChatStreamHandle {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: options.messages,
          ...(options.modelSource === undefined ? {} : { modelSource: options.modelSource }),
          ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
          ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
          ...(options.tools === undefined ? {} : { tools: options.tools }),
          ...(options.net === undefined ? {} : { net: options.net }),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
          ...(options.promptTemplate === undefined
            ? {}
            : { promptTemplate: options.promptTemplate }),
          ...(options.maxToolIterations === undefined
            ? {}
            : { maxToolIterations: options.maxToolIterations }),
          ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
          ...(options.skills === undefined || options.skills.length === 0
            ? {}
            : { skills: options.skills }),
        }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let message = `Chat request failed (${response.status}).`;
        try {
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          /* keep the generic message */
        }
        options.onError(message);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('');
          if (!payload) continue;

          try {
            options.onEvent(JSON.parse(payload) as ChatEvent);
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') options.onError((error as Error).message);
    } finally {
      options.onClose();
    }
  })();

  return { abort: () => controller.abort() };
}

/** Skills (`skills/*.md`). */
export const skillsApi = {
  list: (): Promise<{ count: number; root: string; skills: SkillRecord[] }> =>
    request('/api/skills'),
  read: (name: string): Promise<{ skill: SkillDetailFull }> =>
    request(`/api/skills/${encodeURIComponent(name)}`),
  create: (input: {
    name: string;
    description: string;
    when?: string;
    body?: string;
  }): Promise<{ skill: SkillDetailFull }> =>
    request('/api/skills', { method: 'POST', body: input }),
  update: (
    name: string,
    patch: { description?: string; when?: string; body?: string },
  ): Promise<{ skill: SkillDetailFull }> =>
    request(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: patch }),
  remove: (name: string): Promise<{ removed: { name: string } }> =>
    request(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

/** Internet capabilities. */
export const webApi = {
  search: (query: string, limit = 5): Promise<SearchReport> =>
    request(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  fetch: (url: string, maxChars = 4000): Promise<WebPage> =>
    request('/api/web/fetch', { method: 'POST', body: { url, maxChars } }),
};

/** MCP server pool. */
/**
 * Tool files behind the toolbox MCP server: the Toolbox tab's whole API.
 *
 * Saving and removing both answer with the server's reload report, so the tab
 * can say what the tool list just gained or lost instead of guessing.
 */
export const toolboxApi = {
  list: (): Promise<ToolboxSnapshot> => request<ToolboxSnapshot>('/api/toolbox'),

  read: (name: string): Promise<{ name: string; content: string; bytes: number; mtime: string }> =>
    request(`/api/toolbox/file?name=${encodeURIComponent(name)}`),

  save: (name: string, content: string): Promise<ToolboxSaveResult> =>
    request<ToolboxSaveResult>('/api/toolbox/file', { method: 'PUT', body: { name, content } }),

  remove: (name: string): Promise<ToolboxSaveResult> =>
    request<ToolboxSaveResult>(`/api/toolbox/file?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  reload: (): Promise<{ reload: ToolboxReload }> =>
    request('/api/toolbox/reload', { method: 'POST', body: {} }),
};

export const mcpApi = {
  list: (): Promise<McpCatalogue> => request('/api/mcp'),
  add: (input: {
    name: string;
    command: string;
    args?: string[];
    description?: string;
  }): Promise<McpCatalogue> => request('/api/mcp/servers', { method: 'POST', body: input }),
  remove: (name: string): Promise<McpCatalogue> =>
    request(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  start: (name: string): Promise<unknown> =>
    request(`/api/mcp/servers/${encodeURIComponent(name)}/start`, { method: 'POST', body: {} }),
  stop: (name: string): Promise<unknown> =>
    request(`/api/mcp/servers/${encodeURIComponent(name)}/stop`, { method: 'POST', body: {} }),
  call: (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ server: string; tool: string; ok: boolean; text: string; durationMs: number }> =>
    request('/api/mcp/tools', { method: 'POST', body: { tool, args } }),
};

export const chatApi = {
  status: (): Promise<{ status: EngineStatus; config: ChatConfig }> => request('/api/chat/status'),

  unload: (): Promise<{ status: EngineStatus }> => request('/api/chat/model', { method: 'DELETE' }),

  /** The `models/` catalogue. */
  models: (): Promise<ModelCatalog> => request('/api/models'),

  /** Select a model; chat-specific selections don't rewrite the global default. */
  useModel: (id: string, persist = true): Promise<ModelCatalog & { status: EngineStatus }> =>
    request('/api/models/active', { method: 'PUT', body: { id, persist } }),

  /** Adopt GGUFs dropped into either folder by hand. */
  refreshModels: (): Promise<ModelCatalog> => request('/api/models/refresh', { method: 'POST' }),

  /** Downloads a model's weights, reporting progress until it finishes. */
  download: (
    onProgress: (progress: number, status: EngineStatus) => void,
    onDone: (status: EngineStatus) => void,
    onError: (message: string) => void,
    id?: string,
  ): ChatStreamHandle => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch('/api/chat/model/download', {
          method: 'POST',
          signal: controller.signal,
          headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify(id ? { id } : {}),
        });
        if (!response.ok || !response.body) {
          onError(`Download failed (${response.status}).`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');

            const payload = frame
              .split('\n')
              .filter((line) => line.startsWith('data: '))
              .map((line) => line.slice(6))
              .join('');
            if (!payload) continue;

            try {
              const parsed = JSON.parse(payload) as {
                type: string;
                message?: string;
                status?: EngineStatus;
              };
              if (parsed.type === 'error') onError(parsed.message ?? 'Download failed.');
              else if (parsed.type === 'done' && parsed.status) onDone(parsed.status);
              else if (parsed.status) onProgress(parsed.status.downloadProgress, parsed.status);
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') onError((error as Error).message);
      }
    })();

    return { abort: () => controller.abort() };
  },
};

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

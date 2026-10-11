/**
 * Thin client for the InfAgent API. All paths are relative so the interface
 * works identically when served by `infagent serve` or the Vite dev proxy.
 */
import type {
  CreateScriptInput,
  Health,
  ScriptDetail,
  ScriptRecord,
  ScriptRunResult,
  ScriptStats,
  ToolDefinition,
} from './types';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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

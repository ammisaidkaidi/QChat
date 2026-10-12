/**
 * The 🔧 picker beside the message box: which MCP servers one turn may use.
 *
 * Two halves are checked here, because either alone would be a false promise:
 * the servers the model is *shown* (the prompt's tool list), and the servers it
 * is *allowed to call* (the dispatcher). A selection that hid a tool but still
 * ran it would be a filter in appearance only.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, toolboxNames } from '../src/chat/prompt.js';
import { selectMcpServers } from '../src/chat/qwen.js';
import { dispatchTool } from '../src/chat/tools.js';
import type { McpManager } from '../src/mcp/manager.js';
import { ScriptRegistry } from '../src/scripts/registry.js';

function freshRegistry(): ScriptRegistry {
  return new ScriptRegistry({
    root: join(mkdtempSync(join(tmpdir(), 'infagent-mcp-pick-')), 'scripts'),
  });
}

/** The manager surface the selection and the dispatcher actually use. */
function fakeManager(
  servers: { name: string; enabled: boolean; description?: string; state?: string }[],
  calls: string[] = [],
): McpManager {
  return {
    list: () =>
      servers.map((server) => ({
        name: server.name,
        enabled: server.enabled,
        description: server.description ?? '',
        state: server.state ?? 'ready',
      })),
    tools: () =>
      servers.map((server) => ({
        server: server.name,
        tool: {
          name: 'ping',
          description: `${server.name} ping.`,
          inputSchema: { type: 'object' },
        },
      })),
    call: async (qualified: string) => {
      calls.push(qualified);
      return {
        server: qualified.split('__')[0] ?? '',
        tool: 'ping',
        result: { ok: true, text: '{"pong":true}', isError: false, durationMs: 1 },
      };
    },
  } as unknown as McpManager;
}

const CATALOGUE = [
  { name: 'code', enabled: true, description: 'Code sandbox.' },
  { name: 'toolbox', enabled: true, description: 'Your tool files.' },
  { name: 'sqlite', enabled: false, description: 'A database, switched off in mcp.json.' },
];

describe('selectMcpServers', () => {
  it('keeps every enabled server when the request says nothing', () => {
    expect(selectMcpServers(CATALOGUE).map((server) => server.name)).toEqual(['code', 'toolbox']);
  });

  it('keeps exactly the selected servers, still leaving disabled ones out', () => {
    expect(selectMcpServers(CATALOGUE, ['toolbox']).map((server) => server.name)).toEqual([
      'toolbox',
    ]);
    // Ticking a server that `mcp.json` disables does not enable it.
    expect(selectMcpServers(CATALOGUE, ['sqlite'])).toEqual([]);
  });

  it('reads an empty selection as no server at all, not as no restriction', () => {
    expect(selectMcpServers(CATALOGUE, [])).toEqual([]);
  });

  it('ignores a name that is no longer a server', () => {
    expect(
      selectMcpServers(CATALOGUE, ['toolbox', 'removed-since']).map((server) => server.name),
    ).toEqual(['toolbox']);
  });

  it('cuts the prompt and the grammar down to the selected servers', () => {
    const manager = fakeManager(CATALOGUE);
    const allowed = selectMcpServers(manager.list(), ['toolbox']);
    const mcp = manager
      .tools()
      .filter(({ server }) => allowed.some((entry) => entry.name === server));
    const options = {
      records: freshRegistry().list(),
      net: false,
      mcp: mcp.map(({ server, tool }) => ({
        server,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
    const prompt = buildSystemPrompt({
      ...options,
      tools: true,
      thinking: false,
      toolBudget: 20000,
    });

    // The script toolbox's own callbacks stay; of the MCP tools, only the
    // selected server's remain — in the grammar's name list and in the prompt.
    const names = toolboxNames(options);
    expect(names).toContain('toolbox__ping');
    expect(names).not.toContain('code__ping');
    expect(names.filter((name) => name.includes('__'))).toEqual(['toolbox__ping']);
    expect(prompt).toContain('toolbox__ping');
    expect(prompt).not.toContain('code__ping');
    expect(prompt).toContain('MCP servers: toolbox');
    expect(prompt).not.toContain('MCP servers: code');
  });
});

describe('the dispatcher enforces the same selection', () => {
  it('runs a call to a selected server', async () => {
    const calls: string[] = [];
    const result = await dispatchTool(
      { name: 'toolbox__ping', args: {} },
      { registry: freshRegistry(), mcp: fakeManager(CATALOGUE, calls), mcpAllowed: ['toolbox'] },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['toolbox__ping']);
  });

  it('refuses a call to a server the picker left out, without calling it', async () => {
    const calls: string[] = [];
    const result = await dispatchTool(
      { name: 'code__ping', args: {} },
      { registry: freshRegistry(), mcp: fakeManager(CATALOGUE, calls), mcpAllowed: ['toolbox'] },
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/code.*switched off/i);
    expect(calls).toEqual([]);
  });

  it('refuses everything when nothing is selected, and allows everything when unset', async () => {
    const calls: string[] = [];
    const manager = fakeManager(CATALOGUE, calls);
    const none = await dispatchTool(
      { name: 'code__ping', args: {} },
      { registry: freshRegistry(), mcp: manager, mcpAllowed: [] },
    );
    expect(none.ok).toBe(false);
    expect(calls).toEqual([]);

    const unrestricted = await dispatchTool(
      { name: 'code__ping', args: {} },
      { registry: freshRegistry(), mcp: manager },
    );
    expect(unrestricted.ok).toBe(true);
    expect(calls).toEqual(['code__ping']);
  });

  it('leaves the script toolbox alone — the picker is about MCP servers only', async () => {
    const result = await dispatchTool(
      { name: 'listScripts', args: {} },
      { registry: freshRegistry(), mcpAllowed: [] },
    );
    expect(result.ok).toBe(true);
  });
});

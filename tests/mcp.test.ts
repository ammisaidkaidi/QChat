import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { McpClient, McpError } from '../src/mcp/client.js';
import { McpManager, parseQualifiedTool } from '../src/mcp/manager.js';

const EXAMPLE_SERVER = fileURLToPath(new URL('../mcp/example-server.mjs', import.meta.url));

const clients: McpClient[] = [];
afterAll(async () => {
  for (const client of clients) await client.stop();
});

describe('McpClient', () => {
  it('handshakes and lists tools', async () => {
    const client = new McpClient('example', {
      command: process.execPath,
      args: [EXAMPLE_SERVER],
    });
    clients.push(client);

    await client.start();
    expect(client.state).toBe('ready');
    expect(client.serverInfo.name).toBe('infagent-example');
    expect(client.tools.map((tool) => tool.name).sort()).toEqual(['add', 'echo', 'now']);
    expect(client.tools.find((tool) => tool.name === 'add')?.inputSchema).toMatchObject({
      type: 'object',
    });
  }, 20_000);

  it('calls tools and reports failures as content', async () => {
    const client = new McpClient('example', { command: process.execPath, args: [EXAMPLE_SERVER] });
    clients.push(client);
    await client.start();

    const echoed = await client.callTool('echo', { text: 'hello mcp' });
    expect(echoed.ok).toBe(true);
    expect(echoed.text).toBe('hello mcp');

    const sum = await client.callTool('add', { a: 2, b: 40 });
    expect(sum.text).toBe('42');

    const bad = await client.callTool('add', { a: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.isError).toBe(true);
  }, 20_000);

  it('stops cleanly and refuses to keep working', async () => {
    const client = new McpClient('example', { command: process.execPath, args: [EXAMPLE_SERVER] });
    await client.start();
    await client.stop();
    expect(client.state).toBe('stopped');
    await expect(client.callTool('echo', { text: 'x' })).rejects.toBeInstanceOf(McpError);
  }, 20_000);

  it('surfaces a timeout instead of hanging', async () => {
    const client = new McpClient('slow', {
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      timeoutMs: 300,
    });
    clients.push(client);

    await expect(client.start()).rejects.toMatchObject({ code: 'timeout' });
    await client.stop();
  }, 20_000);
});

describe('McpManager', () => {
  function manager(): McpManager {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-mcp-'));
    const configPath = join(dir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          example: {
            command: process.execPath,
            args: [EXAMPLE_SERVER],
            description: 'test server',
          },
        },
      }),
    );
    return new McpManager({ configPath });
  }

  it('starts configured servers and exposes namespaced tools', async () => {
    const pool = manager();
    const statuses = await pool.startEnabled();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.state).toBe('ready');

    const catalogue = pool.catalogue();
    expect(catalogue.tools.map((tool) => tool.qualified)).toContain('example__echo');
    await pool.stopAll();
  }, 20_000);

  it('calls a namespaced tool and returns its text', async () => {
    const pool = manager();
    const called = await pool.call('example__echo', { text: 'through the pool' });
    expect(called.server).toBe('example');
    expect(called.tool).toBe('echo');
    expect(called.result.text).toBe('through the pool');
    await pool.stopAll();
  }, 20_000);

  it('writes a default config when none exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-mcp-'));
    const configPath = join(dir, 'mcp.json');
    const pool = new McpManager({ configPath });
    expect(pool.names()).toEqual(['example']);
    expect(pool.status('example').enabled).toBe(true);
  });

  it('rejects unknown servers and malformed names', async () => {
    const pool = manager();
    await expect(pool.call('nope__echo', {})).rejects.toBeInstanceOf(McpError);
    expect(() => pool.addServer('bad name', { command: 'node' })).toThrow(/Invalid server name/);
  });

  it('parses qualified names', () => {
    expect(parseQualifiedTool('example__echo', ['example'])).toEqual({
      server: 'example',
      tool: 'echo',
    });
    expect(parseQualifiedTool('example__echo', ['other'])).toBeNull();
    expect(parseQualifiedTool('plain', ['example'])).toBeNull();
  });
});

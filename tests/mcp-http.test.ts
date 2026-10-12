/**
 * Tests for MCP over Streamable HTTP (the transport the official Supabase
 * endpoint speaks) and for the guard that keeps that endpoint read-only.
 *
 * A local mock server plays the remote role: it answers both the JSON and the
 * SSE shape, demands the header it was configured with, and can be told to
 * fail or to stall. No Supabase credentials are needed or used.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { redact, secretsOf } from '../src/mcp/http.js';
import { McpManager } from '../src/mcp/manager.js';

const TOKEN = 'sbp_test_token_do_not_use_1234567890';

// The mock server is plain http on 127.0.0.1, which the manager allows only
// through this explicit opt-in — the same rule a real deployment follows.
process.env['INFAGENT_MCP_ALLOW_INSECURE'] = '1';

interface MockOptions {
  /** Reply with SSE frames instead of a JSON body. */
  sse?: boolean;
  /** Require this Authorization header. */
  token?: string;
  /** Answer with this status instead of a result. */
  failWith?: number;
  /** Body sent with `failWith` (defaults to a plain denial). */
  failBody?: unknown;
  /** Wait this long before answering. */
  delayMs?: number;
}

async function mockRemote(options: MockOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: string[];
  headers: Record<string, string>[];
}> {
  const calls: string[] = [];
  const headers: Record<string, string>[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    headers.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])));
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const reply = (payload: unknown, status = 200): void => {
        const send = (): void => {
          if (options.failWith) {
            res.writeHead(options.failWith, { 'content-type': 'application/json' });
            res.end(JSON.stringify(options.failBody ?? { error: 'denied' }));
            return;
          }
          if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          if (options.sse) {
            res.writeHead(status, {
              'content-type': 'text/event-stream',
              'mcp-session-id': 'session-1',
            });
            res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            return;
          }
          res.writeHead(status, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
          res.end(JSON.stringify(payload));
        };
        if (options.delayMs) setTimeout(send, options.delayMs);
        else send();
      };

      let message: { id?: number; method?: string; params?: { name?: string } };
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        res.writeHead(400).end();
        return;
      }
      calls.push(message.method ?? 'notification');

      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      switch (message.method) {
        case 'initialize':
          reply({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-supabase', version: '9.9.9' },
            },
          });
          break;
        case 'tools/list':
          reply({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'list_tables',
                  description: 'List tables in the linked project',
                  inputSchema: {
                    type: 'object',
                    properties: { schemas: { type: 'array', items: { type: 'string' } } },
                  },
                },
              ],
            },
          });
          break;
        case 'tools/call':
          reply({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: `called ${message.params?.name} with ${TOKEN}` }] },
          });
          break;
        default:
          reply({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } });
      }
    });
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((done) => server.close(() => done())),
    calls,
    headers,
  };
}

function managerFor(url: string, extra: Record<string, unknown> = {}): McpManager {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-http-'));
  const configPath = join(dir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      servers: {
        remote: {
          transport: 'http',
          url,
          headers: { Authorization: `Bearer ${TOKEN}` },
          timeoutMs: 2000,
          ...extra,
        },
      },
    }),
  );
  return new McpManager({ configPath });
}

const managers: McpManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll();
});

describe('MCP over HTTP', () => {
  it('initializes, lists tools and calls one', async () => {
    const remote = await mockRemote();
    const manager = managerFor(remote.url);
    managers.push(manager);

    try {
      const status = await manager.start('remote');
      expect(status.state).toBe('ready');
      expect(status.transport).toBe('http');
      expect(status.serverInfo).toMatchObject({ name: 'mock-supabase' });
      expect(status.tools.map((tool) => tool.name)).toEqual(['list_tables']);
      expect(remote.calls).toEqual(['initialize', 'notifications/initialized', 'tools/list']);

      const result = await manager.call('remote__list_tables', { schemas: ['public'] });
      expect(result.result.ok).toBe(true);
      expect(remote.calls.at(-1)).toBe('tools/call');
    } finally {
      await remote.close();
    }
  });

  it('understands the SSE reply shape', async () => {
    const remote = await mockRemote({ sse: true });
    const manager = managerFor(remote.url);
    managers.push(manager);

    try {
      const status = await manager.start('remote');
      expect(status.state).toBe('ready');
      expect(status.tools).toHaveLength(1);
    } finally {
      await remote.close();
    }
  });

  it('redacts the token it sees in results and errors', async () => {
    const remote = await mockRemote();
    const manager = managerFor(remote.url);
    managers.push(manager);

    try {
      await manager.start('remote');
      const result = await manager.call('remote__list_tables', {});
      expect(result.result.text).toContain('called list_tables');
      expect(result.result.text).not.toContain(TOKEN);
      expect(result.result.text).toContain('***');
    } finally {
      await remote.close();
    }
  });

  it('reports a failed authentication without leaking the token', async () => {
    const remote = await mockRemote({ token: 'a-different-token' });
    const manager = managerFor(remote.url);
    managers.push(manager);

    try {
      const status = await manager.start('remote');
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/authentication failed/);
      expect(JSON.stringify(status)).not.toContain(TOKEN);
      expect(status.stderr.join('\n')).not.toContain(TOKEN);
    } finally {
      await remote.close();
    }
  });

  it('identifies itself with a real User-Agent', async () => {
    // Hosted endpoints sit behind an edge that bans library default agents; the
    // request has to look like a client the edge accepts.
    const remote = await mockRemote();
    const manager = managerFor(remote.url);
    try {
      await manager.start('remote');
      const first = remote.headers[0] ?? {};
      expect(first['user-agent']).toContain('InfAgent');
      expect(first['accept']).toContain('text/event-stream');
      expect(first['mcp-protocol-version']).toBeTruthy();
      // No agent leaks the session header before initialize answers.
      expect(first['authorization']).toBe(`Bearer ${TOKEN}`);
    } finally {
      await manager.stopAll();
      await remote.close();
    }
  }, 20_000);

  it('calls an edge block an edge block, not an authentication problem', async () => {
    const remote = await mockRemote({
      failWith: 403,
      failBody: {
        title: 'Error 1010: Access denied',
        detail: "The site owner has blocked access based on your browser's signature.",
        error_code: 1010,
        error_name: 'browser_signature_banned',
      },
    });
    const manager = managerFor(remote.url);
    try {
      // A refused connection is reported as a status, not thrown at the caller.
      const status = await manager.start('remote');
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/edge refused/);
      expect(status.lastError).toMatch(/not a token problem/);
      expect(status.lastError).not.toContain(TOKEN);
      expect(status.lastError).not.toMatch(/Check the token/);
      const stderr = status.stderr.join('\n');
      expect(stderr).toMatch(/1010/);
      expect(stderr).not.toContain(TOKEN);
    } finally {
      await manager.stopAll();
      await remote.close();
    }
  }, 20_000);

  it('times out instead of hanging on a stalled server', async () => {
    const remote = await mockRemote({ delayMs: 1500 });
    const manager = managerFor(remote.url, { timeoutMs: 300 });
    managers.push(manager);

    try {
      const status = await manager.start('remote');
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/timed out|reach/);
    } finally {
      await remote.close();
    }
  });
});

describe('remote guards', () => {
  it('refuses a plain-http remote', async () => {
    const manager = managerFor('http://mcp.supabase.com/mcp');
    managers.push(manager);
    const status = await manager.start('remote');
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/must use https/);
  });

  it('refuses loopback http unless it is opted into', async () => {
    const remote = await mockRemote();
    delete process.env['INFAGENT_MCP_ALLOW_INSECURE'];
    try {
      const manager = managerFor(remote.url);
      managers.push(manager);
      const status = await manager.start('remote');
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/INFAGENT_MCP_ALLOW_INSECURE/);
    } finally {
      process.env['INFAGENT_MCP_ALLOW_INSECURE'] = '1';
      await remote.close();
    }
  });

  it('refuses the Supabase endpoint without a read_only flag', async () => {
    const manager = managerFor('https://mcp.supabase.com/mcp?project_ref=demo&features=database');
    managers.push(manager);
    const status = await manager.start('remote');
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/read_only=true/);
  });

  it('refuses the Supabase endpoint without a token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-http-'));
    const configPath = join(dir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          remote: {
            transport: 'http',
            url: 'https://mcp.supabase.com/mcp?project_ref=demo&read_only=true',
          },
        },
      }),
    );
    const manager = new McpManager({ configPath });
    managers.push(manager);

    const status = await manager.start('remote');
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  it('expands ${ENV} placeholders from the environment', async () => {
    const remote = await mockRemote();
    process.env['INFAGENT_TEST_MCP_URL'] = remote.url;
    process.env['INFAGENT_TEST_MCP_TOKEN'] = TOKEN;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'infagent-http-'));
      const configPath = join(dir, 'mcp.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          servers: {
            remote: {
              transport: 'http',
              url: '${INFAGENT_TEST_MCP_URL}',
              headers: { Authorization: 'Bearer ${INFAGENT_TEST_MCP_TOKEN}' },
            },
          },
        }),
      );
      const manager = new McpManager({ configPath });
      managers.push(manager);

      const status = await manager.start('remote');
      expect(status.state).toBe('ready');
      expect(status.url).toBe(remote.url);
    } finally {
      await remote.close();
      delete process.env['INFAGENT_TEST_MCP_URL'];
      delete process.env['INFAGENT_TEST_MCP_TOKEN'];
    }
  });
});

describe('redaction helpers', () => {
  it('masks bearer tokens, keys and query secrets', () => {
    expect(redact(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
    expect(redact('https://x/mcp?access_token=abc123&project_ref=demo')).toContain('access_token=***');
    expect(redact('call failed: sbp_live_abcdef123456')).not.toContain('sbp_live_abcdef123456');
  });

  it('collects the secrets of a config', () => {
    expect(secretsOf({ headers: { authorization: `Bearer ${TOKEN}`, accept: '*/*' } })).toEqual([TOKEN]);
    expect(secretsOf({ env: { DB_PASSWORD: 'hunter2' } })).toEqual(['hunter2']);
  });
});

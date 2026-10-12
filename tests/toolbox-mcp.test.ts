/**
 * The toolbox MCP server (`mcp/servers/toolbox.mjs`), driven over stdio.
 *
 * A tool file is `export default [{name, description, callback}]`. Every claim
 * the server makes about those files is checked here against the real process:
 * the shape it accepts, the names and files it refuses, the root confinement,
 * the output cap, the time limit, and the reload path — including the
 * `notifications/tools/list_changed` that puts a new tool into the chat's
 * context without restarting anything.
 */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { buildSystemPrompt, toolboxNames } from '../src/chat/prompt.js';
import { McpClient } from '../src/mcp/client.js';
import { ScriptRegistry } from '../src/scripts/registry.js';

const SERVER = fileURLToPath(new URL('../mcp/servers/toolbox.mjs', import.meta.url));
const SCRIPTS_DIR = fileURLToPath(new URL('../scripts', import.meta.url));

const clients: McpClient[] = [];
afterAll(async () => {
  for (const client of clients) await client.stop();
});

/** A folder of tool files, written fresh for one test. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-toolbox-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

async function start(root: string, config: Record<string, unknown> = {}): Promise<McpClient> {
  const client = new McpClient('toolbox', {
    command: process.execPath,
    args: [SERVER, JSON.stringify({ root, timeout_ms: 2_000, ...config })],
  });
  clients.push(client);
  await client.start();
  return client;
}

/** Call a tool and parse the JSON text it answered with. */
async function call(
  client: McpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const outcome = await client.callTool(tool, args);
  if (!outcome.ok) throw new Error(outcome.text);
  return JSON.parse(outcome.text) as Record<string, unknown>;
}

const GREET = `export default [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    callback: ({ who }) => ({ greeting: 'Hello ' + who + '!' }),
  },
];`;

describe('the toolbox server', () => {
  it('lists the tools a file exports, with its schema', async () => {
    const client = await start(fixture({ 'hello.js': GREET }));
    expect(client.serverInfo.name).toBe('infagent-toolbox');
    expect(client.tools.map((tool) => tool.name).sort()).toEqual([
      'greet',
      'reload_tools',
      'tool_files',
    ]);
    const greet = client.tools.find((tool) => tool.name === 'greet');
    expect(greet?.description).toContain('Greet someone by name.');
    expect(greet?.description).toContain('hello.js');
    expect(greet?.inputSchema).toMatchObject({ required: ['who'] });
    // The list is announced as changeable: the client has to be able to hear it.
    expect(client.toolsChangedAt).toBeNull();
  }, 20_000);

  it('runs a callback and returns its value as JSON', async () => {
    const client = await start(fixture({ 'hello.js': GREET }));
    const result = await call(client, 'greet', { who: 'Amine' });
    expect(result).toEqual({ greeting: 'Hello Amine!' });
  }, 20_000);

  it('awaits an async callback and turns undefined into null', async () => {
    const client = await start(
      fixture({
        'mix.js': `export default [
          { name: 'later', description: 'Async.', callback: async ({ n }) => ({ doubled: n * 2 }) },
          { name: 'nothing', description: 'Returns nothing.', callback: () => undefined },
        ];`,
      }),
    );
    expect(await call(client, 'later', { n: 21 })).toEqual({ doubled: 42 });
    const outcome = await client.callTool('nothing', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe('null');
  }, 20_000);

  it('survives the values JSON cannot carry', async () => {
    const client = await start(
      fixture({
        'weird.js': `export default [
          {
            name: 'weird',
            description: 'Functions, cycles, bigints.',
            callback: () => {
              const node = { name: 'root', n: 10n, fn: () => 1 };
              node.self = node;
              return { node, list: [1, undefined, () => 2] };
            },
          },
        ];`,
      }),
    );
    const result = await call(client, 'weird', {});
    expect(result['node']).toMatchObject({ n: '10', self: '[circular]' });
    expect(JSON.stringify(result['node'])).not.toContain('fn');
    expect(result['list']).toEqual([1, null, null]);
  }, 20_000);

  it('reports a throwing callback as a failed call, with its message', async () => {
    const client = await start(
      fixture({
        'boom.js': `export default [
          { name: 'boom', description: 'Fails.', callback: () => { throw new Error('the kettle is empty'); } },
        ];`,
      }),
    );
    const outcome = await client.callTool('boom', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('the kettle is empty');
  }, 20_000);

  it('stops a callback that never answers', async () => {
    const client = await start(
      fixture({
        'slow.js': `export default [
          { name: 'slow', description: 'Hangs.', callback: () => new Promise(() => {}) },
        ];`,
      }),
      { timeout_ms: 500 },
    );
    const outcome = await client.callTool('slow', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('did not answer within 500 ms');
  }, 20_000);

  it('caps what a callback may return', async () => {
    const client = await start(
      fixture({
        'big.js': `export default [
          { name: 'big', description: 'Prints a lot.', callback: () => 'x'.repeat(5000) },
        ];`,
      }),
      { max_result_bytes: 500 },
    );
    const outcome = await client.callTool('big', {});
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('… (truncated:');
    expect(outcome.text.length).toBeLessThan(700);
  }, 20_000);

  it('refuses a file that does not export an array, and says so', async () => {
    const client = await start(
      fixture({
        'bad.js': 'export default { name: "not-an-array" };',
        'hello.js': GREET,
      }),
    );
    expect(client.tools.map((tool) => tool.name)).toContain('greet');
    const report = await call(client, 'tool_files', {});
    expect(report['refused']).toEqual([
      expect.stringContaining('bad.js must `export default` an array'),
    ]);
    expect(report['tools']).toEqual(['greet']);
  }, 20_000);

  it('skips an entry without a callback and keeps the rest of the file', async () => {
    const client = await start(
      fixture({
        'partial.js': `export default [
          { name: 'good', description: 'Fine.', callback: () => 'ok' },
          { name: 'nocallback', description: 'Not callable.' },
          { name: 'Bad-Name', description: 'Not a tool name.', callback: () => 1 },
        ];`,
      }),
    );
    expect(client.tools.map((tool) => tool.name)).toContain('good');
    const report = await call(client, 'tool_files', {});
    const refused = report['refused'] as string[];
    expect(refused.join('\n')).toContain('`nocallback` has no callback function');
    expect(refused.join('\n')).toContain('is not a tool name');
  }, 20_000);

  it('refuses a name that is already taken, and a name of its own', async () => {
    const client = await start(
      fixture({
        'a.js': `export default [
          { name: 'shared', description: 'First.', callback: () => ({ from: 'a' }) },
        ];`,
        'b.js': `export default [
          { name: 'shared', description: 'Second.', callback: () => ({ from: 'b' }) },
          { name: 'reload_tools', description: 'Mine now.', callback: () => ({ from: 'b' }) },
        ];`,
      }),
    );
    expect(await call(client, 'shared', {})).toEqual({ from: 'a' });
    const report = await call(client, 'tool_files', {});
    const refused = (report['refused'] as string[]).join('\n');
    expect(refused).toContain('`shared` is already defined by');
    expect(refused).toMatch(/already defined by .*a\.js/);
    expect(refused).toContain('`reload_tools` is this server');
  }, 20_000);

  it('never follows a file out of its root, and says which one it skipped', async () => {
    const root = fixture({ 'hello.js': GREET });
    symlinkSync('/etc/hostname', join(root, 'escape.js'));
    const client = await start(root);
    const report = await call(client, 'tool_files', {});
    expect(report['tools']).toEqual(['greet']);
    expect(report['refused']).toEqual([expect.stringContaining('is a symlink')]);
    // The unusable file did not stop the usable one from loading.
    expect(await call(client, 'greet', { who: 'Amine' })).toEqual({ greeting: 'Hello Amine!' });
  }, 20_000);

  it('reports what was loaded: file, mtime and hash', async () => {
    const client = await start(fixture({ 'hello.js': GREET }));
    const report = await call(client, 'tool_files', {});
    const files = report['files'] as {
      file: string;
      sha256: string;
      mtime: string;
      tools: string;
    }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files[0]?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(files[0]?.tools).toEqual(['greet']);
  }, 20_000);

  it('picks up an edited file and announces the new tool list', async () => {
    const root = fixture({ 'hello.js': GREET });
    const client = await start(root);

    // A new tool in a new file, while the server is running.
    writeFileSync(
      join(root, 'extra.js'),
      `export default [
        { name: 'shout', description: 'Upper case.', callback: ({ text }) => String(text).toUpperCase() },
      ];`,
      'utf8',
    );

    const report = await call(client, 'reload_tools', {});
    expect(report['added']).toEqual(['shout']);
    expect(report['removed']).toEqual([]);

    // The notification reached the client, which re-read the list: this is what
    // puts `toolbox__shout` into the model's context from the next turn on.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.toolsChangedAt).not.toBeNull();
    expect(client.tools.map((tool) => tool.name)).toContain('shout');
    const shouted = await client.callTool('shout', { text: 'quiet' });
    expect(shouted.ok).toBe(true);
    expect(shouted.text).toBe('QUIET');

    // And a tool that goes away is reported too.
    writeFileSync(join(root, 'extra.js'), 'export default [];', 'utf8');
    const second = await call(client, 'reload_tools', { force: true });
    expect(second['removed']).toEqual(['shout']);
  }, 30_000);

  it('declares the tools in the prompt exactly as the grammar offers them', async () => {
    const client = await start(fixture({ 'hello.js': GREET }));
    const mcp = client.tools.map((tool) => ({
      server: 'toolbox',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    const prompt = buildSystemPrompt({
      records: new ScriptRegistry({ root: SCRIPTS_DIR }).list(),
      tools: true,
      thinking: false,
      mcp,
      mcpServers: [{ name: 'toolbox', description: 'Tool files — your JS tools.' }],
    });
    expect(prompt).toContain('toolbox__greet');
    expect(prompt).toContain('toolbox — ');

    const names = toolboxNames({ records: [], mcp });
    expect(names).toContain('toolbox__greet');
    expect(names).toContain('toolbox__reload_tools');
  }, 20_000);
});

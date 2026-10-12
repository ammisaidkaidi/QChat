/**
 * The Toolbox tab's API (`/api/toolbox`), against a real HTTP server and a real
 * toolbox MCP server.
 *
 * The tab edits files that a running server will import, so the tests edit real
 * files in a temporary folder and then read the server's own reload report:
 * creating, saving, breaking, deleting, and every name or path the API is
 * supposed to refuse.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillRegistry } from '../src/skills/registry.js';
import { McpManager } from '../src/mcp/manager.js';
import { ScriptRegistry } from '../src/scripts/registry.js';
import { createServer } from '../src/server/server.js';
import { ToolboxError, ToolboxFiles, checkName, toolboxRoot } from '../src/mcp/toolboxFiles.js';

const SERVER = fileURLToPath(new URL('../mcp/servers/toolbox.mjs', import.meta.url));

interface Harness {
  dir: string;
  root: string;
  url: string;
  manager: McpManager;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.close();
});

/** A repo-shaped temp folder: an mcp.json with a toolbox entry, and the files. */
async function start(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-toolbox-api-'));
  const root = join(dir, 'mcp', 'tools');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'skills'), { recursive: true });

  const configPath = join(dir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: {
          toolbox: {
            command: process.execPath,
            args: [SERVER, JSON.stringify({ root })],
            enabled: true,
            description: 'Tool files, under test.',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const manager = new McpManager({ configPath });
  const server = createServer({
    mcp: manager,
    registry: new ScriptRegistry({ root: join(dir, 'scripts') }),
    skills: new SkillRegistry({ root: join(dir, 'skills') }),
    uiDir: join(dir, 'ui'),
    envFile: join(dir, '.env'),
    envReference: join(dir, '.env.example'),
    chatDbPath: join(dir, 'chats.sqlite'),
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${address.port}`;

  // The manager connects the servers in the background; wait for the toolbox.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = manager.list().find((entry) => entry.name === 'toolbox')?.state;
    if (state === 'ready' || state === 'error') break;

    await new Promise((wait) => setTimeout(wait, 100));
  }

  const harness: Harness = {
    dir,
    root,
    url,
    manager,
    close: async () => {
      await manager.stopAll();
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
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

const GREET = `export default [
  {
    name: 'greet',
    description: 'Greet someone.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    callback: ({ who }) => ({ greeting: 'Hello ' + who + '!' }),
  },
];`;

describe('the toolbox file API', () => {
  it('lists the folder, the tools in it and the server state', async () => {
    const harness = await start();
    writeFileSync(join(harness.root, 'hello.js'), GREET, 'utf8');
    // Force a reload so the server sees the file written after it started.
    await call(harness, '/api/toolbox/reload', { method: 'POST', body: {} });

    const { status, body } = await call(harness, '/api/toolbox');
    expect(status).toBe(200);
    expect(body['root']).toBe(harness.root);
    const files = body['files'] as { name: string; tools: string[]; loaded: boolean }[];
    expect(files.map((file) => file.name)).toEqual(['hello.js']);
    expect(files[0]?.tools).toEqual(['greet']);
    expect(files[0]?.loaded).toBe(true);
    expect(body['tools']).toEqual(['greet']);
    expect((body['server'] as { state: string }).state).toBe('ready');
    expect(body['limits']).toEqual({ maxBytes: 65_536, maxFiles: 32 });
  }, 30_000);

  it('creates a file and reports the tool it just made callable', async () => {
    const harness = await start();
    const saved = await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'hello.js', content: GREET },
    });
    expect(saved.status).toBe(200);
    expect(existsSync(join(harness.root, 'hello.js'))).toBe(true);
    const reload = saved.body['reload'] as { ok: boolean; added: string[]; removed: string[] };
    expect(reload.ok).toBe(true);
    expect(reload.added).toEqual(['greet']);
    expect(reload.removed).toEqual([]);

    const read = await call(harness, '/api/toolbox/file?name=hello.js');
    expect(read.body['content']).toBe(GREET);

    const called = await harness.manager.call('toolbox__greet', { who: 'Amine' });
    expect(called.result.ok).toBe(true);
    expect(called.result.text).toContain('Hello Amine!');
  }, 30_000);

  it('saves an edit and keeps the same tool', async () => {
    const harness = await start();
    await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'hello.js', content: GREET },
    });

    const edited = GREET.replace('Hello ', 'Hi ');
    const saved = await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'hello.js', content: edited },
    });
    expect(saved.status).toBe(200);
    expect((saved.body['reload'] as { added: string[] }).added).toEqual([]);

    const called = await harness.manager.call('toolbox__greet', { who: 'Amine' });
    expect(called.result.text).toContain('Hi Amine!');
  }, 30_000);

  it('saves a file the server refuses, and says so', async () => {
    const harness = await start();
    const saved = await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'broken.js', content: 'export default { name: "not an array" };' },
    });
    // The write itself is a file operation, not a load: it happened, and the
    // report carries the refusal that explains why nothing became callable.
    expect(saved.status).toBe(200);
    const reload = saved.body['reload'] as { added: string[]; refused: string[] };
    expect(reload.added).toEqual([]);
    expect(reload.refused.join('\n')).toContain('must `export default` an array');
    expect(existsSync(join(harness.root, 'broken.js'))).toBe(true);
  }, 30_000);

  it('deletes a file and reports the tool that went with it', async () => {
    const harness = await start();
    writeFileSync(join(harness.root, 'hello.js'), GREET, 'utf8');
    await call(harness, '/api/toolbox/reload', { method: 'POST', body: {} });

    const removed = await call(harness, '/api/toolbox/file?name=hello.js', { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(existsSync(join(harness.root, 'hello.js'))).toBe(false);
    expect((removed.body['reload'] as { removed: string[] }).removed).toEqual(['greet']);

    const after = await call(harness, '/api/toolbox');
    expect(after.body['tools']).toEqual([]);
  }, 30_000);

  it('refuses names that are not plain tool file names', async () => {
    const harness = await start();
    for (const name of ['../escape.js', 'sub/dir.js', 'notes.txt', '.hidden.js', '']) {
      const response = await call(harness, '/api/toolbox/file', {
        method: 'PUT',
        body: { name, content: 'export default [];' },
      });
      expect(response.status, name).toBe(400);
      expect(String(response.body['error']), name).toMatch(/name|\.js/);
    }
    // And nothing landed next to the folder.
    expect(existsSync(join(harness.dir, 'escape.js'))).toBe(false);
  }, 30_000);

  it('refuses to read or write through a symlink out of the root', async () => {
    const harness = await start();
    const outside = join(harness.dir, 'outside.js');
    writeFileSync(outside, 'export default [];', 'utf8');
    symlinkSync(outside, join(harness.root, 'link.js'));

    const read = await call(harness, '/api/toolbox/file?name=link.js');
    expect(read.status).toBe(400);
    expect(String(read.body['error'])).toContain('plain file');

    const write = await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'link.js', content: 'export default [];' },
    });
    expect(write.status).toBe(400);
    // The file it points at is untouched.
    expect(existsSync(outside)).toBe(true);
  }, 30_000);

  it('refuses a file that is too big, and one that has gone missing', async () => {
    const harness = await start();
    const tooBig = await call(harness, '/api/toolbox/file', {
      method: 'PUT',
      body: { name: 'big.js', content: 'x'.repeat(70_000) },
    });
    expect(tooBig.status).toBe(400);
    expect(String(tooBig.body['error'])).toContain('limit is 65536');
    expect(existsSync(join(harness.root, 'big.js'))).toBe(false);

    const missing = await call(harness, '/api/toolbox/file?name=nope.js');
    expect(missing.status).toBe(404);
    const missingDelete = await call(harness, '/api/toolbox/file?name=nope.js', {
      method: 'DELETE',
    });
    expect(missingDelete.status).toBe(404);
  }, 30_000);
});

describe('the toolbox folder itself', () => {
  it('takes its root from the mcp.json entry, and falls back to mcp/tools', () => {
    const manager = {
      list: () => [{ name: 'toolbox', args: ['mcp/servers/toolbox.mjs', '{"root":"mcp/mine"}'] }],
    } as unknown as McpManager;
    expect(toolboxRoot(manager).endsWith(join('mcp', 'mine'))).toBe(true);
    expect(
      toolboxRoot({ list: () => [] } as unknown as McpManager).endsWith(join('mcp', 'tools')),
    ).toBe(true);
  });

  it('checks a name before it becomes a path', () => {
    expect(checkName('my-tools.js')).toBe('my-tools.js');
    expect(checkName('tools.mjs')).toBe('tools.mjs');
    for (const bad of ['My Tools.js', 'tools.py', '..', 'a/../b.js']) {
      expect(() => checkName(bad), bad).toThrow(ToolboxError);
    }
  });

  it('writes atomically and leaves no temporary file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'infagent-toolbox-files-'));
    const files = new ToolboxFiles(join(dir, 'tools'));
    files.write('one.js', 'export default [];');
    expect(files.list().map((file) => file.name)).toEqual(['one.js']);
    expect(files.read('one.js').content).toBe('export default [];');
    expect(files.remove('one.js').name).toBe('one.js');
    expect(files.list()).toEqual([]);
    expect(existsSync(join(dir, 'tools', '.one.js.saving'))).toBe(false);
  });
});

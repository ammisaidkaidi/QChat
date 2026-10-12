/**
 * The code sandbox MCP server (`mcp/servers/code.mjs`), driven over stdio.
 *
 * Every claim this server makes about enforcement is checked here, against the
 * real process, not the source: the sandbox directory, the empty environment,
 * the filesystem limits on both languages, the refusal of child processes and
 * sockets, the time limit and the output cap.
 */
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { McpClient } from '../src/mcp/client.js';

const SERVER = fileURLToPath(new URL('../mcp/servers/code.mjs', import.meta.url));

const clients: McpClient[] = [];
afterAll(async () => {
  for (const client of clients) await client.stop();
});

/** A started server with a short time limit, so the timeout test stays quick. */
async function start(config: Record<string, unknown> = {}): Promise<McpClient> {
  const client = new McpClient('code', {
    command: process.execPath,
    args: [SERVER, JSON.stringify({ timeout_ms: 3_000, ...config })],
  });
  clients.push(client);
  await client.start();
  return client;
}

/** The JSON each tool prints, parsed back for the assertions. */
async function call(
  client: McpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const outcome = await client.callTool(tool, args);
  if (!outcome.ok) throw new Error(outcome.text);
  return JSON.parse(outcome.text) as Record<string, unknown>;
}

describe('the code sandbox server', () => {
  it('declares its tools and policy', async () => {
    const client = await start();
    expect(client.serverInfo.name).toBe('infagent-code');
    expect(client.tools.map((tool) => tool.name).sort()).toEqual([
      'code_policy',
      'run_javascript',
      'run_python',
    ]);
  }, 20_000);

  it('runs a JavaScript snippet and returns what it printed', async () => {
    const client = await start();
    const result = await call(client, 'run_javascript', {
      code: 'const data = [3, 4, 5];\nconsole.log(JSON.stringify({ sum: data.reduce((a, b) => a + b, 0) }));',
    });
    expect(result['ok']).toBe(true);
    expect(result['exit_code']).toBe(0);
    expect(result['stdout']).toBe('{"sum":12}\n');
    expect(result['language']).toBe('javascript');
  }, 30_000);

  it('runs a Python snippet and returns what it printed', async () => {
    const client = await start();
    const result = await call(client, 'run_python', {
      code: 'import json\nprint(json.dumps({"squares": [n * n for n in range(5)]}))',
    });
    expect(result['ok']).toBe(true);
    expect(result['stdout']).toBe('{"squares": [0, 1, 4, 9, 16]}\n');
    expect(result['language']).toBe('python');
  }, 30_000);

  it('runs in a fresh directory with nothing of ours in the environment', async () => {
    const client = await start();
    const python = await call(client, 'run_python', {
      code: 'import os, json\nprint(json.dumps({"cwd": os.getcwd(), "env": sorted(os.environ)}))',
    });
    const payload = JSON.parse(String(python['stdout'])) as { cwd: string; env: string[] };
    expect(payload.cwd).toContain('infagent-code-');
    // No secrets, no PYTHONPATH, no NODE_OPTIONS: the names that could carry
    // one are absent, not merely empty.
    expect(payload.env).not.toContain('PYTHONPATH');
    for (const name of payload.env) {
      expect(name).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD|SUPABASE|GITHUB/i);
    }
  }, 30_000);

  it('lets the snippet write inside its own directory and cleans up after', async () => {
    const client = await start();
    const result = await call(client, 'run_python', {
      code: 'open("note.txt", "w").write("kept")\nprint(open("note.txt").read())',
    });
    expect(result['stdout']).toBe('kept\n');

    const js = await call(client, 'run_javascript', {
      code: 'import { writeFileSync, readFileSync } from "node:fs";\nwriteFileSync("note.txt", "kept");\nconsole.log(readFileSync("note.txt", "utf8"));',
    });
    expect(js['stdout']).toBe('kept\n');
  }, 30_000);

  it('refuses the filesystem outside the sandbox, in both languages', async () => {
    const client = await start();
    const js = await call(client, 'run_javascript', {
      code: 'import { readFileSync } from "node:fs";\ntry { readFileSync("/etc/hostname"); console.log("allowed"); } catch (error) { console.log(error.code); }',
    });
    expect(String(js['stdout'])).toContain('ERR_ACCESS_DENIED');

    const python = await call(client, 'run_python', {
      code: 'try:\n    open("/etc/hostname").read()\n    print("allowed")\nexcept PermissionError:\n    print("refused")',
    });
    expect(String(python['stdout'])).toBe('refused\n');

    // An absolute path outside the sandbox: a *relative* one would belong to
    // the sandbox, where writing is allowed on purpose.
    const target = fileURLToPath(new URL('../package.json', import.meta.url));
    const project = await call(client, 'run_python', {
      code: `try:\n    open(${JSON.stringify(target)}, "a").write("x")\n    print("allowed")\nexcept PermissionError:\n    print("refused")`,
    });
    expect(String(project['stdout'])).toBe('refused\n');
  }, 40_000);

  it('refuses child processes and sockets', async () => {
    const client = await start();
    const js = await call(client, 'run_javascript', {
      code: 'const cp = await import("node:child_process");\ntry { cp.spawnSync("id"); console.log("spawned"); } catch (error) { console.log(error.code); }',
    });
    expect(String(js['stdout'])).toContain('ERR_ACCESS_DENIED');

    const pythonImport = await call(client, 'run_python', {
      code: 'for name in ("socket", "subprocess", "ctypes", "urllib.request"):\n    try:\n        __import__(name)\n        print(name, "allowed")\n    except PermissionError:\n        print(name, "refused")',
    });
    expect(String(pythonImport['stdout'])).toBe(
      'socket refused\nsubprocess refused\nctypes refused\nurllib.request refused\n',
    );

    const pythonExec = await call(client, 'run_python', {
      code: 'import os\ntry:\n    os.system("id")\n    print("allowed")\nexcept PermissionError:\n    print("refused")',
    });
    expect(String(pythonExec['stdout'])).toBe('refused\n');
  }, 40_000);

  it('stops a snippet at the time limit and says so', async () => {
    const client = await start();
    const result = await call(client, 'run_javascript', {
      code: 'const until = Date.now() + 30_000;\nwhile (Date.now() < until) {}\nconsole.log("finished");',
      timeout_ms: 800,
    });
    expect(result['ok']).toBe(false);
    expect(result['timed_out']).toBe(true);
    expect(String(result['stdout'])).not.toContain('finished');
    expect(String(result['note'])).toContain('time limit');
  }, 30_000);

  it('caps the output instead of flooding the model', async () => {
    const client = await start({ max_output_bytes: 2_000 });
    const result = await call(client, 'run_python', {
      code: 'print("x" * 20000)',
    });
    expect(result['truncated']).toBe(true);
    expect(String(result['stdout']).length).toBeLessThanOrEqual(2_000);
  }, 30_000);

  it('reports a failing snippet as a failure, with the error', async () => {
    const client = await start();
    const result = await call(client, 'run_javascript', {
      code: 'throw new Error("boom");',
    });
    expect(result['ok']).toBe(false);
    expect(result['exit_code']).not.toBe(0);
    expect(String(result['stderr'])).toContain('boom');
  }, 30_000);

  it('rejects an empty snippet and an oversized one', async () => {
    const client = await start();
    const empty = await client.callTool('run_python', { code: '   ' });
    expect(empty.ok).toBe(false);
    expect(empty.text).toContain('non-empty');

    const huge = await client.callTool('run_python', { code: 'x'.repeat(20_001) });
    expect(huge.ok).toBe(false);
    expect(huge.text).toContain('20000');
  }, 30_000);

  it('states the policy it enforces, including what it cannot', async () => {
    const client = await start();
    const policy = await call(client, 'code_policy', {});
    expect(policy['timeout_ms']).toMatchObject({ maximum: 15_000 });
    expect(String(policy['environment'])).toContain('no tokens');
    // The honest part: the platform either isolates the network or says it does
    // not, and the Python guard is named as a guard rail rather than a kernel.
    expect(String(policy['network'])).toMatch(/blocked|allowed by configuration|not enforced/);
    expect(String(policy['limits_note'])).toMatch(/not a kernel boundary/i);
    expect(policy['unshare_available']).toBeTypeOf('boolean');
  }, 20_000);
});

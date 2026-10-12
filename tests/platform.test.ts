import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveUiDir, staticFileFor } from '../src/server/server.js';

const ROOT = process.cwd();

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('the built interface is found on every platform', () => {
  it('resolves ui/dist next to the repo', () => {
    expect(resolveUiDir('file:///home/dev/app/dist/server/main.js')).toBe('/home/dev/app/ui/dist');
  });

  it.runIf(process.platform === 'win32')(
    'resolves a Windows drive letter, not a doubled one',
    () => {
      // The old `.pathname` gave "/D:/dev/app/ui/dist" and path.resolve turned that
      // into "D:\D:\dev\app\ui\dist" — a path that never exists, so the server
      // claimed the interface had not been built however often you built it.
      expect(resolveUiDir('file:///D:/dev/app/dist/server/main.js')).toBe(
        win32.resolve('D:/dev/app/ui/dist'),
      );
    },
  );

  it('never builds a filesystem path from a URL pathname', () => {
    // Guard for the whole class: `.pathname` is fine for URLs, never for files.
    for (const file of sourceFiles()) {
      // Comments may discuss the pattern; code may not use it.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(/import\.meta\.url[^\n]*\.pathname|new URL\([^;]*\)\.pathname/.test(code), file).toBe(
        false,
      );
    }
  });
});

describe('static file resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infagent-ui-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html>InfAgent');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1);');
  writeFileSync(join(tmpdir(), 'infagent-outside.txt'), 'outside');

  it('serves a file that is inside the build', () => {
    expect(staticFileFor(dir, '/assets/app.js')).toBe(join(dir, 'assets', 'app.js'));
  });

  it('falls back to index.html for client-side routes', () => {
    expect(staticFileFor(dir, '/chat/42')).toBe(join(dir, 'index.html'));
  });

  it('never leaves the build folder, plain or percent-encoded', () => {
    for (const attempt of [
      '/../infagent-outside.txt',
      '/%2e%2e/infagent-outside.txt',
      '/..%2f..%2fetc%2fpasswd',
      '/assets/../../infagent-outside.txt',
    ]) {
      expect(staticFileFor(dir, attempt), attempt).toBe(join(dir, 'index.html'));
    }
  });
});

describe('the python MCP launcher', () => {
  const launcher = join(ROOT, 'mcp', 'servers', 'python.mjs');
  const hasPython =
    spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ||
    spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0 ||
    spawnSync('py', ['--version'], { stdio: 'ignore' }).status === 0;

  it('explains itself when a config file is missing an argument', () => {
    const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage: node mcp\/servers\/python\.mjs/);
  });

  it('names a missing interpreter instead of failing silently', () => {
    const result = spawnSync(process.execPath, [launcher, 'missing.py'], {
      encoding: 'utf8',
      env: { ...process.env, INFAGENT_PYTHON: join(tmpdir(), 'not-a-python') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Could not start|No Python interpreter/);
  });

  it.runIf(hasPython)(
    'runs the sqlite server whatever python is called here',
    () => {
      // The bundled demo database, read-only: the same config mcp.json ships.
      const args = JSON.stringify({
        databases: { demo: './mcp/data/demo.db' },
        read_only: true,
      });
      const child = spawnSync(
        process.execPath,
        [launcher, join(ROOT, 'mcp', 'servers', 'sqlite.py'), args],
        {
          encoding: 'utf8',
          input:
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'test', version: '1' },
              },
            })}\n` +
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
          timeout: 30_000,
        },
      );

      const tools = /"tools"/.test(child.stdout ?? '');
      expect(tools, child.stderr?.slice(0, 300)).toBe(true);
    },
    40_000,
  );
});

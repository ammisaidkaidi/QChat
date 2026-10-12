import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { buildHeader, composeScript, parseHeader } from '../src/scripts/header.js';
import { interpreterFor, pythonInterpreter, runScriptFile } from '../src/scripts/runner.js';
import { ScriptError, ScriptRegistry } from '../src/scripts/registry.js';
import type { ScriptMeta } from '../src/scripts/types.js';

const meta: ScriptMeta = {
  version: 'infagent-script/v1',
  name: 'greet',
  language: 'js',
  description: 'Say hello to someone.',
  callback: 'run({ name }) -> { ok, result }',
  usage: 'node scripts/greet.js \'{"name":"World"}\'',
  params: [{ name: 'name', type: 'string', required: false, description: 'Who to greet.' }],
  agentPrompt: 'Use this script when the user greets someone.\nPass the person name.',
};

describe('script header contract', () => {
  it('round-trips every field for js', () => {
    const header = buildHeader(meta);
    expect(header.startsWith('/**')).toBe(true);

    const parsed = parseHeader(header, 'js', 'greet');
    expect(parsed.found).toBe(true);
    expect(parsed.meta.name).toBe('greet');
    expect(parsed.meta.language).toBe('js');
    expect(parsed.meta.description).toBe(meta.description);
    expect(parsed.meta.callback).toBe(meta.callback);
    expect(parsed.meta.params).toEqual(meta.params);
    expect(parsed.meta.agentPrompt).toContain('Use this script when the user greets someone.');
    expect(parsed.meta.agentPrompt).toContain('Pass the person name.');
  });

  it('round-trips every field for python', () => {
    const python = { ...meta, language: 'py' as const };
    const header = buildHeader(python);
    expect(header.startsWith('"""')).toBe(true);

    const parsed = parseHeader(header, 'py', 'greet');
    expect(parsed.found).toBe(true);
    expect(parsed.meta.language).toBe('py');
    expect(parsed.meta.agentPrompt).toContain('Pass the person name.');
  });

  it('falls back gracefully when the header is missing', () => {
    const parsed = parseHeader('console.log("no header");', 'js', 'stray');
    expect(parsed.found).toBe(false);
    expect(parsed.meta.name).toBe('stray');
    expect(parsed.meta.description).toBe('');
  });

  it('composeScript emits a header followed by the body', () => {
    const source = composeScript(meta, 'export function run() { return 42; }\n');
    expect(source.startsWith('/**')).toBe(true);
    expect(source).toContain('export function run() { return 42; }');
    expect(parseHeader(source, 'js', 'greet').found).toBe(true);
  });
});

describe('ScriptRegistry', () => {
  let root: string;
  let registry: ScriptRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'infagent-scripts-'));
    registry = new ScriptRegistry({ root, allowRun: true, timeoutMs: 15_000 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('starts empty and creates the folder on demand', () => {
    expect(registry.list()).toEqual([]);
    expect(registry.stats().count).toBe(0);
  });

  it('createScript writes a self-describing file', () => {
    const created = registry.create({
      name: 'hello',
      language: 'js',
      description: 'Greet someone.',
      params: [{ name: 'name', type: 'string', required: true }],
    });

    expect(created.meta.name).toBe('hello');
    expect(created.meta.description).toBe('Greet someone.');
    expect(created.relativePath.endsWith('hello.js')).toBe(true);

    const onDisk = readFileSync(join(root, 'hello.js'), 'utf8');
    expect(onDisk).toContain('@infagent-script v1');
    expect(onDisk).toContain('@agent');
    expect(onDisk).toContain('export function run');
    expect(parseHeader(onDisk, 'js', 'hello').meta.params[0]?.name).toBe('name');
  });

  it('refuses to clobber unless overwrite is set', () => {
    registry.create({ name: 'dup', language: 'js', description: 'first' });
    expect(() => registry.create({ name: 'dup', language: 'js', description: 'second' })).toThrow(
      ScriptError,
    );
    const replaced = registry.create({
      name: 'dup',
      language: 'js',
      description: 'second',
      overwrite: true,
    });
    expect(replaced.meta.description).toBe('second');
  });

  it('validates names', () => {
    expect(() => registry.create({ name: 'Bad Name', language: 'js', description: 'x' })).toThrow(
      ScriptError,
    );
    expect(() => registry.create({ name: '../escape', language: 'js', description: 'x' })).toThrow(
      ScriptError,
    );
  });

  it('lists, reads, searches and removes', () => {
    registry.create({ name: 'alpha', language: 'js', description: 'Report disk usage.' });
    registry.create({ name: 'beta', language: 'py', description: 'Send a webhook.' });

    expect(registry.list().map((record) => record.meta.name)).toEqual(['alpha', 'beta']);
    expect(registry.stats().byLanguage).toEqual({ js: 1, py: 1 });
    expect(registry.search('disk').map((record) => record.meta.name)).toEqual(['alpha']);
    expect(registry.read('beta').source).toContain('@infagent-script');

    const removed = registry.remove('alpha');
    expect(removed.name).toBe('alpha');
    expect(registry.list().map((record) => record.meta.name)).toEqual(['beta']);
    expect(() => registry.read('alpha')).toThrow(ScriptError);
  });

  it('update() patches the header and keeps the body editable', () => {
    registry.create({ name: 'patchme', language: 'py', description: 'before' });
    const updated = registry.update('patchme', {
      description: 'after',
      body: 'def run(args):\n    return {"ok": True}\n',
    });
    expect(updated.meta.description).toBe('after');
    expect(updated.source).toContain('def run(args):');
    expect(updated.source).toContain('@description after');
  });

  it('exposes the agent prompt and tool schemas', () => {
    registry.create({ name: 'hello', language: 'js', description: 'Greet someone.' });
    const prompt = registry.agentPrompt('hello');
    expect(prompt).toContain('# Script "hello"');
    expect(prompt).toContain('runScript');
    expect(prompt).toContain('POST /api/scripts/hello/run');

    const names = registry.toolDefinitions().map((tool) => tool.name);
    expect(names).toContain('createScript');
    expect(names).toContain('removeScript');
    expect(names).toContain('listScripts');
    expect(names).toContain('runScript');

    expect(registry.systemPrompt()).toContain('hello');
  });

  it('run() executes a js script and parses the envelope', async () => {
    registry.create({
      name: 'echoer',
      language: 'js',
      description: 'Echo back the arguments.',
      body: [
        'export function run(args = {}) {',
        '  return { echoed: args };',
        '}',
        '',
        "if (process.argv[1] && import.meta.url.endsWith('echoer.js')) {",
        '  const payload = process.argv[2] ? JSON.parse(process.argv[2]) : {};',
        '  process.stdout.write(JSON.stringify({ ok: true, result: run(payload) }));',
        '}',
        '',
      ].join('\n'),
    });

    const result = await registry.run('echoer', { ping: 'pong' });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect((result.envelope as { result: { echoed: { ping: string } } }).result.echoed.ping).toBe(
      'pong',
    );
  });

  it('run() reports failures instead of throwing', async () => {
    registry.create({
      name: 'boom',
      language: 'js',
      description: 'Always fails.',
      body: "process.stdout.write(JSON.stringify({ ok: false, error: 'nope' }));\nprocess.exitCode = 1;\n",
    });

    const result = await registry.run('boom');
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect((result.envelope as { error: string }).error).toBe('nope');
  });

  it('run() respects INFAGENT_ALLOW_RUN=0', async () => {
    const locked = new ScriptRegistry({ root, allowRun: false });
    locked.create({ name: 'locked', language: 'js', description: 'x' });
    await expect(locked.run('locked')).rejects.toThrow(ScriptError);
  });
});

/* ── interpreters ───────────────────────────────────────────────────────── */

describe('script interpreters', () => {
  it('runs javascript with the current node binary', () => {
    expect(interpreterFor('js')).toBe(process.execPath);
  });

  it('lets INFAGENT_PYTHON win, and otherwise finds a python that answers', () => {
    const previous = process.env['INFAGENT_PYTHON'];
    try {
      process.env['INFAGENT_PYTHON'] = 'C:/tools/python.exe';
      expect(pythonInterpreter()).toBe('C:/tools/python.exe');
    } finally {
      if (previous === undefined) delete process.env['INFAGENT_PYTHON'];
      else process.env['INFAGENT_PYTHON'] = previous;
    }

    // Without the override the resolver probes python3 → python → py, so it
    // works on Windows (which has no `python3`) as well as on Linux.
    const found = pythonInterpreter();
    expect(['python3', 'python', 'py']).toContain(found);
  });

  it('runs a python script when this machine has an interpreter', async () => {
    const python = pythonInterpreter();
    const available = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
    if (!available) {
      // Nothing to test on a machine without Python — the ENOENT path is
      // reported as a normal script error instead.
      expect(available).toBe(false);
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'infagent-py-'));
    const file = join(dir, 'echo.py');
    writeFileSync(file, 'import json, sys\nprint(json.dumps({"ok": True, "result": json.loads(sys.argv[1])}))\n');

    const result = await runScriptFile(file, 'py', 'echo', { hello: 'world' }, { timeoutMs: 20_000 });
    expect(result.ok, result.stderr).toBe(true);
    expect(result.envelope).toEqual({ ok: true, result: { hello: 'world' } });
  }, 30_000);
});

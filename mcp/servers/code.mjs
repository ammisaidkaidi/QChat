#!/usr/bin/env node
/**
 * Code sandbox MCP server: run a JavaScript or Python snippet from the chat.
 *
 *   node mcp/servers/code.mjs '{"timeout_ms":5000,"max_output_bytes":65536}'
 *
 * Tools: `run_javascript`, `run_python`, `code_policy`.
 *
 * Every run gets a fresh directory in the system temp folder, an empty
 * environment (no tokens, no `HOME`, no `PYTHON*` variables) and a hard time
 * limit. What is *enforced*, rather than asked for in a prompt:
 *
 *   JavaScript  `node --experimental-permission`: reading and writing outside
 *               the sandbox directory is refused by Node itself, and so is
 *               `child_process`, workers and native addons.
 *   Python      `python3 -I -B` with `mcp/lib/pyguard.py`: an audit hook refuses
 *               reads outside the sandbox and the interpreter's own library,
 *               writes outside the sandbox, process creation and sockets; the
 *               modules that would step around it (`ctypes`, `subprocess`, …)
 *               cannot be imported.
 *   both        output is capped per stream, the process group is killed on the
 *               time limit, and the sandbox directory is deleted afterwards.
 *   network     `unshare -n --map-current-user` when the platform has it (Linux
 *               user namespaces): the snippet runs with no network interface at
 *               all. `code_policy` reports whether that is in force here.
 *
 * Honest limits, also printed by `code_policy`: on a platform without
 * `unshare`, JavaScript can still open sockets, and a Python snippet that finds
 * a language-level escape from the audit hook can too. The interpreter is not a
 * kernel boundary; the filesystem and process checks above are the guard rails.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFromArgv, serve, ToolError } from '../lib/protocol.mjs';

const config = configFromArgv();

/** Hard ceiling for one run, whatever the caller asks for. */
const MAX_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 262_144;

const TIMEOUT_MS = Math.min(Math.max(Number(config.timeout_ms ?? 5_000), 100), MAX_TIMEOUT_MS);
const OUTPUT_LIMIT = Math.min(
  Math.max(Number(config.max_output_bytes ?? 65_536), 1_024),
  MAX_OUTPUT_BYTES,
);
const ALLOW_NETWORK = config.allow_network === true;
const PYTHON_OVERRIDE = process.env['INFAGENT_PYTHON'] ?? null;

/** The sandbox guard, kept next to this server. */
const PYGUARD = new URL('../lib/pyguard.py', import.meta.url).pathname;

const PYTHON_CANDIDATES = ['python3', 'python', 'py'];

function answers(binary, args) {
  try {
    return spawnSync(binary, args, { stdio: 'ignore', timeout: 5_000 }).status === 0;
  } catch {
    return false;
  }
}

/** First Python interpreter that answers `--version`. */
function pythonInterpreter() {
  if (PYTHON_OVERRIDE) return PYTHON_OVERRIDE;
  for (const candidate of PYTHON_CANDIDATES) {
    if (answers(candidate, ['--version'])) return candidate;
  }
  return null;
}

/**
 * Can this platform run a snippet with no network?
 *
 * A new network namespace needs either root or a user namespace. `-r` alone
 * would map us to root, which would *widen* filesystem access; `--map-current-user`
 * keeps the same uid inside the namespace, so the filesystem stays as it is and
 * only the network is taken away. Probed once, then reported by `code_policy`.
 */
const NETWORK_ISOLATION = (() => {
  if (process.platform !== 'linux') return null;
  if (!spawnSync('unshare', ['--version'], { stdio: 'ignore' }).status === 0) return null;
  const probe = spawnSync('unshare', ['-n', '--map-current-user', 'true'], { stdio: 'ignore' });
  return probe.status === 0 ? ['unshare', '-n', '--map-current-user'] : null;
})();

/** The environment a snippet sees: nothing that could hold a secret. */
function sandboxEnv(sandbox, language) {
  const env = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: sandbox,
    TMPDIR: sandbox,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    LC_ALL: process.env['LC_ALL'] ?? 'C.UTF-8',
    // Python's own noise reduction; no PYTHONPATH, so nothing of ours leaks in.
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    NO_COLOR: '1',
  };
  if (language === 'javascript') env['NODE_OPTIONS'] = '';
  return env;
}

/** Run one command with a sandboxed environment, capped output and a time limit. */
function execute({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: the kill below takes the whole tree, not just the
      // interpreter, and cannot touch this server.
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cap = (current, chunk) => {
      if (current.length >= OUTPUT_LIMIT) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > OUTPUT_LIMIT) truncated = true;
      return next.slice(0, OUTPUT_LIMIT);
    };

    child.stdout.on('data', (chunk) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = cap(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exit_code: code,
        timed_out: timedOut,
        truncated,
        duration_ms: Date.now() - startedAt,
      });
    };

    child.on('error', (error) => {
      stderr = `${stderr}${error.message}\n`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** SIGTERM then SIGKILL on the process group, so nothing keeps running. */
function killTree(child) {
  const signal = (name) => {
    try {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        /* already gone */
      }
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 500);
}

/** Wrap the command for the network-less run when the platform supports it. */
function networkWrapped(command, args) {
  if (ALLOW_NETWORK || !NETWORK_ISOLATION) return { command, args };
  return { command: NETWORK_ISOLATION[0], args: [...NETWORK_ISOLATION.slice(1), command, ...args] };
}

/** Run a finished snippet's result into the shape both tools return. */
function report(language, run, extra = {}) {
  const ok = run.exit_code === 0 && !run.timed_out;
  const note = run.timed_out
    ? `Stopped after ${TIMEOUT_MS} ms: the time limit is part of the sandbox.`
    : run.truncated
      ? `Output was cut at ${OUTPUT_LIMIT} characters.`
      : '';
  return {
    ok,
    language,
    exit_code: run.exit_code,
    stdout: run.stdout,
    stderr: run.stderr,
    timed_out: run.timed_out,
    truncated: run.truncated,
    duration_ms: run.duration_ms,
    sandbox: 'fresh temp directory, empty environment, deleted after the run',
    network: ALLOW_NETWORK
      ? 'allowed by configuration'
      : NETWORK_ISOLATION
        ? 'blocked (network namespace)'
        : 'not enforced on this platform',
    note,
    ...extra,
  };
}

/** Both runners share the sandbox setup; only the command differs. */
async function runSnippet(language, request) {
  const code = typeof request.code === 'string' ? request.code : '';
  if (code.trim().length === 0) throw new ToolError('`code` must be a non-empty string.');
  if (code.length > 20_000) throw new ToolError('`code` is limited to 20000 characters.');

  const timeoutMs = Math.min(
    Math.max(Number(request.timeout_ms ?? TIMEOUT_MS), 100),
    MAX_TIMEOUT_MS,
  );
  const sandbox = mkdtempSync(join(tmpdir(), 'infagent-code-'));
  const file = join(sandbox, language === 'javascript' ? 'snippet.mjs' : 'snippet.py');
  const env = sandboxEnv(sandbox, language);

  try {
    writeFileSync(file, code, 'utf8');

    const command =
      language === 'javascript'
        ? {
            command: process.execPath,
            args: [
              '--no-warnings',
              // Node's own sandbox: no filesystem outside the sandbox, no child
              // processes, no workers, no native addons. The snippet is a file
              // inside the sandbox rather than a `-e` argument, so the code is
              // never visible in the process table.
              '--experimental-permission',
              `--allow-fs-read=${sandbox}`,
              `--allow-fs-write=${sandbox}`,
              file,
            ],
            extra: { enforced_by: 'node --experimental-permission' },
          }
        : {
            command: pythonInterpreter(),
            args: ['-I', '-B', PYGUARD, sandbox, file],
            extra: { enforced_by: 'audit hook (mcp/lib/pyguard.py)' },
          };

    if (!command.command) {
      throw new ToolError(
        'No Python interpreter found. Install Python or point INFAGENT_PYTHON at one.',
      );
    }

    const wrapped = networkWrapped(command.command, command.args);
    const run = await execute({
      command: wrapped.command,
      args: wrapped.args,
      cwd: sandbox,
      env,
      timeoutMs,
    });
    return report(language, run, command.extra);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

serve({
  name: 'infagent-code',
  version: '1.0.0',
  tools: [
    {
      name: 'run_javascript',
      description:
        'Run JavaScript in a sandbox and return its stdout/stderr (use run_python for Python, not this tool). Call it as run_javascript with {"code": "console.log(1 + 1)"} — the snippet goes in the required "code" argument, and a result must be printed with console.log to be visible. It runs in a fresh temp directory with an empty environment, cannot read or write outside that directory, cannot start processes, and is stopped at the time limit.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript module source.' },
          timeout_ms: { type: 'number', description: 'Time limit in ms.' },
        },
        required: ['code'],
      },
      handler: (args) => runSnippet('javascript', args),
    },
    {
      name: 'run_python',
      description:
        'Run Python in a sandbox and return its stdout/stderr (use run_javascript for JavaScript, not this tool). Call it as run_python with {"code": "print(1 + 1)"} — the snippet goes in the required "code" argument, and a result must be printed with print() to be visible. It runs in a fresh temp directory with an empty environment, cannot read or write outside that directory (plus the interpreter library it needs to import), cannot start processes or open sockets, and is stopped at the time limit.',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source.' },
          timeout_ms: { type: 'number', description: 'Time limit in ms.' },
        },
        required: ['code'],
      },
      handler: (args) => runSnippet('python', args),
    },
    {
      name: 'code_policy',
      description: 'Show exactly what the code sandbox enforces on this machine.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({
        languages: {
          javascript: {
            command: `${process.execPath} --experimental-permission`,
            filesystem: 'read and write limited to the run directory',
            processes: 'child_process, workers and native addons are refused',
          },
          python: {
            interpreter: pythonInterpreter() ?? 'not found',
            command: 'python3 -I -B mcp/lib/pyguard.py <sandbox> <file>',
            filesystem:
              'writes limited to the run directory; reads limited to it and the interpreter library',
            processes: 'os.system/exec/fork and subprocess are refused',
            network: 'socket, ssl, urllib, http and asyncio cannot be imported',
          },
        },
        environment: 'PATH, HOME(sandbox), TMPDIR(sandbox), LANG only — no tokens, no PYTHONPATH',
        network: ALLOW_NETWORK
          ? 'allowed by configuration (allow_network: true)'
          : NETWORK_ISOLATION
            ? `blocked: each run is wrapped in "${NETWORK_ISOLATION.join(' ')}"`
            : 'not enforced on this platform (no user namespaces): JavaScript can open sockets, Python is limited to the import block',
        timeout_ms: { default: TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        max_output_bytes: { limit: OUTPUT_LIMIT, hard_ceiling: MAX_OUTPUT_BYTES },
        cleanup: 'the run directory is deleted after the snippet finishes',
        limits_note:
          'The Python guard is an in-process audit hook, not a kernel boundary: it stops the ordinary ways out, not every conceivable escape. The filesystem, environment and time limits hold regardless.',
        unshare_available: NETWORK_ISOLATION !== null,
        pyguard: existsSync(PYGUARD.replace(/^\/([A-Za-z]:)/, '$1')),
      }),
    },
  ],
});

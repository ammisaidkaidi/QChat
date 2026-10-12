/**
 * Executes agent scripts as child processes.
 *
 * Contract: the script receives a single JSON string argument and prints a
 * JSON envelope (`{ ok: true, result }` / `{ ok: false, error }`) on stdout.
 * No shell is involved, the file must live inside the registry root, and a
 * hard timeout kills runaway scripts.
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

import type { ScriptLanguage, ScriptRunResult } from './types.js';

export interface RunScriptOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the interpreter, e.g. `python3`. */
  binary?: string;
}

/**
 * Candidate Python interpreters, in order of preference.
 *
 * `python3` is the conventional name on Linux and macOS; Windows ships `python`
 * and often `py` instead, which is why a hard-coded `python3` fails there with
 * ENOENT. `INFAGENT_PYTHON` always wins when it is set.
 */
const PYTHON_CANDIDATES = ['python3', 'python', 'py'];

let resolvedPython: string | null = null;

/** True when `binary --version` runs — cheap, and cached by Node's PATH lookup. */
function usable(binary: string): boolean {
  try {
    const probe = spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 5_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** The Python to use: the override, else the first interpreter that answers. */
export function pythonInterpreter(): string {
  // The override is read on every call so a long-lived process (or a test) can
  // change it without clearing the cache.
  const override = process.env['INFAGENT_PYTHON'];
  if (override) return override;
  if (resolvedPython) return resolvedPython;
  for (const candidate of PYTHON_CANDIDATES) {
    if (usable(candidate)) return (resolvedPython = candidate);
  }
  // Nothing found: keep the conventional name so the error message is familiar
  // and the run fails with ENOENT rather than silently doing nothing.
  return (resolvedPython = PYTHON_CANDIDATES[0] as string);
}

export function interpreterFor(language: ScriptLanguage): string {
  return language === 'js' ? process.execPath : pythonInterpreter();
}

export function commandLabel(
  language: ScriptLanguage,
  file: string,
  args: Record<string, unknown>,
): string {
  const payload = JSON.stringify(args);
  const relative = file.replace(`${process.cwd()}/`, '');
  return language === 'js'
    ? `node ${relative} '${payload}'`
    : `${interpreterFor('py')} ${relative} '${payload}'`;
}

function parseEnvelope(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const lastLine = trimmed.split('\n').at(-1) ?? '';
  try {
    return JSON.parse(lastLine);
  } catch {
    return undefined;
  }
}

export async function runScriptFile(
  file: string,
  language: ScriptLanguage,
  name: string,
  args: Record<string, unknown> = {},
  options: RunScriptOptions = {},
): Promise<ScriptRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const binary = options.binary ?? interpreterFor(language);
  const startedAt = Date.now();

  return await new Promise<ScriptRunResult>((resolve) => {
    const child = spawn(binary, [file, JSON.stringify(args)], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, INFAGENT_SCRIPT_NAME: name, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        name,
        language,
        command: commandLabel(language, file, args),
        stdout,
        stderr: `${stderr}${error.message}\n`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut,
        envelope: undefined,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const envelope = parseEnvelope(stdout);
      const ok =
        !timedOut &&
        code === 0 &&
        (envelope === undefined || (envelope as { ok?: boolean }).ok !== false);
      resolve({
        ok,
        name,
        language,
        command: commandLabel(language, file, args),
        stdout,
        stderr: timedOut ? `${stderr}timed out after ${timeoutMs}ms\n` : stderr,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        timedOut,
        envelope,
      });
    });
  });
}

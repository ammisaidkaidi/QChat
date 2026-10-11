/**
 * Executes agent scripts as child processes.
 *
 * Contract: the script receives a single JSON string argument and prints a
 * JSON envelope (`{ ok: true, result }` / `{ ok: false, error }`) on stdout.
 * No shell is involved, the file must live inside the registry root, and a
 * hard timeout kills runaway scripts.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

import type { ScriptLanguage, ScriptRunResult } from './types.js';

export interface RunScriptOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override the interpreter, e.g. `python3`. */
  binary?: string;
}

const INTERPRETERS: Record<ScriptLanguage, string> = {
  js: process.execPath,
  py: process.env['INFAGENT_PYTHON'] ?? 'python3',
};

export function interpreterFor(language: ScriptLanguage): string {
  return INTERPRETERS[language];
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

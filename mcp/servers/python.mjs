#!/usr/bin/env node
/**
 * Run a Python MCP server with whichever interpreter this machine has.
 *
 *   node mcp/servers/python.mjs mcp/servers/sqlite.py '{"databases":{...}}'
 *
 * `mcp.json` cannot name the interpreter portably: `python3` does not exist on
 * Windows (which ships `python` and the `py` launcher instead), so the sqlite
 * server simply never started there. Resolution order is `INFAGENT_PYTHON`,
 * then `python3`, `python`, `py` — the same order the script runner uses.
 *
 * stdio is inherited, so the JSON-RPC stream passes through untouched.
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

export const PYTHON_CANDIDATES = ['python3', 'python', 'py'];

const MISSING =
  'No Python interpreter found. Install Python (python.org or the Microsoft Store), ' +
  'or point INFAGENT_PYTHON at one, e.g. INFAGENT_PYTHON=py.';

function answers(binary) {
  try {
    return spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/** First candidate that answers `--version`; `probe` is injectable for tests. */
export function pickInterpreter(candidates = PYTHON_CANDIDATES, probe = answers) {
  const override = process.env['INFAGENT_PYTHON'];
  if (override) return override;
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  return null;
}

function main() {
  const [script, ...rest] = process.argv.slice(2);
  if (!script) {
    process.stderr.write('Usage: node mcp/servers/python.mjs <script.py> [json-config]\n');
    return 2;
  }

  const python = pickInterpreter();
  if (!python) {
    process.stderr.write(`${MISSING}\n`);
    return 1;
  }

  const child = spawn(python, [script, ...rest], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`Could not start ${python}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return null;
}

// Importing this module (the tests do) must not start anything.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  const code = main();
  if (typeof code === 'number') process.exit(code);
}

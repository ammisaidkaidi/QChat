#!/usr/bin/env node
/**
 * InfAgent CLI — zero-dependency beyond dotenv.
 *
 *   infagent                 show help
 *   infagent config [--json] dump resolved env keys (secrets redacted)
 *   infagent run <task…>     execute a task through the stub agent
 *   infagent --version       print version
 */
import process from 'node:process';

import { ensureEnv, envKeys, envSource, isEnvLoaded, snapshot } from './config/env.js';
import { Agent } from './lib/agent.js';
import { buildInfo } from './version.js';

const HELP = `InfAgent — agent infrastructure toolkit

Usage:
  infagent <command> [options]

Commands:
  run <task...>      Run a task through the agent
  config             Show resolved configuration (secrets redacted)
  help               Show this help

Options:
  -h, --help         Show help
  -v, --version      Show version
  -j, --json         Machine-readable output (config)

Environment:
  Reads .env from the current working directory.
  Regenerate it from env.txt with:  npm run env:from-txt
`;

const argv = process.argv.slice(2);
const wantsJson = argv.includes('--json') || argv.includes('-j');
const args = argv.filter((arg) => arg !== '--json' && arg !== '-j');

async function main(): Promise<number> {
  const [command, ...rest] = args;

  if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    const { name, version, node } = buildInfo();
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify({ name, version, node }, null, 2)}\n`);
    } else {
      process.stdout.write(`${name} v${version} (node ${node})\n`);
    }
    return 0;
  }

  if (command === 'config') {
    const found = ensureEnv();
    const source = envSource() ?? '(process environment only)';
    const declared = envKeys();
    const entries = snapshot(declared.length > 0 ? declared : undefined);

    if (wantsJson) {
      process.stdout.write(
        `${JSON.stringify({ envFileFound: found, envFile: source, entries }, null, 2)}\n`,
      );
      return 0;
    }

    process.stdout.write(`env file : ${source}${found ? '' : ' (not found)'}\n\n`);
    for (const { key, value, sensitive } of entries) {
      process.stdout.write(`${sensitive ? '🔒' : '  '} ${key.padEnd(28)} ${value}\n`);
    }
    return 0;
  }

  if (command === 'run') {
    const task = rest.join(' ').trim();
    if (!task) {
      process.stderr.write('error: `infagent run` needs a task, e.g. infagent run "ping"\n');
      return 2;
    }

    const agent = new Agent();
    const result = await agent.run(task);

    if (wantsJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.ok ? '✔' : '✖'} [${result.agent}] ${result.output}\n`);
    }
    return result.ok ? 0 : 1;
  }

  process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
  return 2;
}

main()
  .then((code) => {
    if (!isEnvLoaded()) ensureEnv({ silent: true });
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

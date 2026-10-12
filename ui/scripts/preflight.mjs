#!/usr/bin/env node
/**
 * Refuse to run `vue-tsc` from anywhere but this package's own install.
 *
 * A global vue-tsc is often an old 1.x, which patches the TypeScript compiler by
 * searching for `/supportedTSExtensions = .*(?=;)/` — a line newer TypeScript
 * removed — and dies with `Search string not found` before `vite build` runs.
 * Checking here turns that crash into one actionable sentence.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fail(lines) {
  process.stderr.write(`\n${lines.join('\n')}\n\n`);
  process.exit(1);
}

let version = '';
try {
  const entry = require.resolve('vue-tsc/package.json');
  version = JSON.parse(readFileSync(entry, 'utf8')).version ?? '';
} catch {
  fail([
    'The interface toolchain is not installed in ui/node_modules.',
    'Run "npm run ui:install" from the repository root (or "npm install" inside ui/),',
    'then "npm run ui:build" again.',
    '',
    'Without it npm falls back to a globally installed vue-tsc, which fails with',
    '"Search string not found: /supportedTSExtensions = .*(?=;)/" on newer TypeScript.',
  ]);
}

if (!/^[2-9]/.test(version)) {
  fail([
    `ui/node_modules/vue-tsc is version ${version}, which is too old for the TypeScript in this repo.`,
    'Run "npm run ui:install" to install the pinned version, then build again.',
  ]);
}

let tsc = '';
try {
  tsc = JSON.parse(readFileSync(require.resolve('typescript/package.json'), 'utf8')).version ?? '';
} catch {
  /* typescript is checked by vue-tsc itself */
}

process.stdout.write(`• vue-tsc ${version}${tsc ? ` · typescript ${tsc}` : ''}\n`);

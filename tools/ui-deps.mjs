#!/usr/bin/env node
/**
 * Install the UI's dependencies as part of the root install.
 *
 * `ui/` is its own npm package, so a root `npm install` does not touch it — and
 * without `ui/node_modules` the build falls back to a globally installed
 * `vue-tsc`, which crashes with `Search string not found:
 * "/supportedTSExtensions = .*(?=;)/"` when that global copy is old. Doing it
 * here means `npm install` is enough on a fresh clone, on any OS.
 *
 * Skips silently when there is nothing to do, when `ui/` is absent (the package
 * is also published as a library), or when `INFAGENT_SKIP_UI_INSTALL=1`.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ui = join(root, 'ui');

const skip = process.env.INFAGENT_SKIP_UI_INSTALL === '1' || process.env.CI === 'true';

function hasDeps() {
  const marker = join(ui, 'node_modules', 'vue-tsc', 'package.json');
  return existsSync(marker);
}

if (skip || !existsSync(join(ui, 'package.json'))) process.exit(0);
if (hasDeps()) process.exit(0);

process.stdout.write('• installing the interface dependencies (ui/)\n');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
  cwd: ui,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.stderr.write(
    '• the interface dependencies could not be installed — run "npm run ui:install" by hand\n',
  );
  // Never fail the root install over the optional UI toolchain.
  process.exit(0);
}

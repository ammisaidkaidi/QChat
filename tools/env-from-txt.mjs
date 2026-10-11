#!/usr/bin/env node
/**
 * env.txt  ->  .env  (+ refreshed .env.example)
 *
 * env.txt is the reference file you hand-edit; `.env` is what the app reads.
 * Run:  npm run env:from-txt  [-- --in env.txt --out .env --example .env.example --force]
 *
 * Rules
 *  - Lines: `KEY=value`, optional `export ` prefix, surrounding quotes stripped.
 *  - `#` comments and blank lines are preserved as comments in .env.
 *  - Values that look like secrets are written to .env but blanked in .env.example.
 *  - The previous .env is copied to .env.bak before being overwritten.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const SENSITIVE_KEY =
  /(SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|SESSION|DSN|CONNECTION[_-]?STRING|DATABASE_URL)/i;

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const force = argv.includes('--force') || argv.includes('-f');
const inFile = resolve(flag('in', 'env.txt'));
const outFile = resolve(flag('out', '.env'));
const exampleFile = resolve(flag('example', '.env.example'));

if (!existsSync(inFile)) {
  process.stderr.write(
    `error: reference file not found: ${inFile}\n\n` +
      `Create env.txt with one KEY=value per line (comments with #), then re-run:\n` +
      `  npm run env:from-txt\n\n` +
      `Example env.txt:\n` +
      `  NODE_ENV=development\n` +
      `  LOG_LEVEL=info\n` +
      `  OPENAI_API_KEY=sk-...\n`,
  );
  process.exit(2);
}

const raw = readFileSync(inFile, 'utf8');
const parsed = [];
let skipped = 0;

for (const original of raw.split(/\r?\n/)) {
  const line = original.trim();

  if (line === '') {
    parsed.push({ kind: 'blank' });
    continue;
  }
  if (line.startsWith('#') || line.startsWith(';')) {
    parsed.push({ kind: 'comment', text: line });
    continue;
  }

  const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
  const eq = withoutExport.indexOf('=');
  if (eq === -1) {
    skipped += 1;
    continue;
  }

  const key = withoutExport.slice(0, eq).trim();
  let value = withoutExport.slice(eq + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1);
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    skipped += 1;
    continue;
  }

  parsed.push({ kind: 'entry', key, value, sensitive: SENSITIVE_KEY.test(key) });
}

const entries = parsed.filter((item) => item.kind === 'entry');
if (entries.length === 0) {
  process.stderr.write(`error: no KEY=value pairs found in ${inFile}\n`);
  process.exit(2);
}

if (existsSync(outFile) && !force) {
  copyFileSync(outFile, `${outFile}.bak`);
}

const header = (source) =>
  [
    `# Generated from ${source} by tools/env-from-txt.mjs`,
    `# Edit ${source}, not this file. Regenerate with: npm run env:from-txt`,
    '',
  ].join('\n');

const envBody = parsed
  .map((item) => {
    if (item.kind === 'blank') return '';
    if (item.kind === 'comment') return item.text;
    return `${item.key}=${item.value}`;
  })
  .join('\n');

const exampleBody = parsed
  .map((item) => {
    if (item.kind === 'blank') return '';
    if (item.kind === 'comment') return item.text;
    return item.sensitive
      ? `${item.key}= # <redacted: value lives in .env>`
      : `${item.key}=${item.value}`;
  })
  .join('\n');

writeFileSync(outFile, `${header('env.txt')}${envBody}\n`, 'utf8');
writeFileSync(
  exampleFile,
  [
    header('env.txt'),
    '# Committed template: sensitive values are blanked here.',
    '# .env holds the real values and is generated, never edited by hand.',
    '',
    exampleBody,
    '',
  ].join('\n'),
  'utf8',
);

const untouched = parsed.filter((item) => item.kind === 'comment').length;
process.stdout.write(
  `✔ ${entries.length} variable${entries.length === 1 ? '' : 's'} written\n` +
    `  → ${outFile}${existsSync(`${outFile}.bak`) ? '  (previous file backed up to .env.bak)' : ''}\n` +
    `  → ${exampleFile}${untouched ? `  (${untouched} comment line${untouched === 1 ? '' : 's'} kept)` : ''}\n` +
    (skipped ? `  ! ${skipped} line${skipped === 1 ? '' : 's'} skipped (not KEY=value)\n` : '') +
    '\nKeys:\n' +
    entries
      .map((entry) => {
        const shown = entry.sensitive ? '<redacted>' : entry.value === '' ? '<empty>' : entry.value;
        return `  ${entry.sensitive ? '🔒' : '  '} ${entry.key} = ${shown}`;
      })
      .join('\n') +
    '\n',
);

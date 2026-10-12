/**
 * Runs the multi-step example end to end, on this machine, with the real model.
 *
 * "List the files in these three folders and count how many files there are" is
 * the task the step loop exists for: one `list_files` per folder, then an answer
 * that adds the three counts up. This script builds three throwaway folders with
 * random names and a known number of files, asks the engine once, and checks the
 * reply against what only the runtime can know:
 *
 *   npm run build                       # the script drives the built engine
 *   node dist/cli.js chat download Qwen3-0.6B-Q4_K_M
 *   node tools/eval-steps.mjs                       # the active model
 *   node tools/eval-steps.mjs --counts 2,5,7 --steps 8
 *   node tools/eval-steps.mjs --runs 3 --json
 *
 * It prints the plans, every call with its arguments and status, the tool
 * results, the answer and the timing, then a verdict on four questions:
 *
 *   folders   was each of the three folders listed (and nothing else re-listed)?
 *   total     does the answer state the count the runtime computed, or does the
 *             runtime append it ("Total across the 3 results: 13 files.")?
 *   calls     did any call fail, and how many steps were used of the budget?
 *   honest    is the answer empty, an error or a different total claimed as one?
 *
 * A run that fails any of them exits non-zero, so the same command works as a
 * check. Nothing here writes to the repository, the weights folder or the
 * settings files; the folders live in the system temp directory and are removed
 * afterwards.
 *
 * Options: --model <id>  --counts 3,4,6  --steps <n>  --runs <n>  --offline  --json
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'chat', 'qwen.js');

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
};

const modelId = typeof flag('model') === 'string' ? flag('model') : undefined;
const runs = Math.max(1, Number(flag('runs', 1)));
const steps = Math.max(1, Number(flag('steps', 6)));
const offline = Boolean(flag('offline', false));
const asJson = Boolean(flag('json', false));
const counts = String(flag('counts', '3,4,6'))
  .split(',')
  .map((entry) => Number(entry.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

if (!existsSync(DIST)) {
  console.error(
    'dist/ is missing — run `npm run build` first (this script drives the built engine).',
  );
  process.exit(1);
}

// A stale dist/ would measure the previous build: refuse rather than mislead.
{
  const built = statSync(DIST).mtimeMs;
  const sources = [
    join(ROOT, 'src', 'chat', 'qwen.ts'),
    join(ROOT, 'src', 'chat', 'protocol.ts'),
    join(ROOT, 'src', 'chat', 'prompt.ts'),
    join(ROOT, 'src', 'chat', 'tools.ts'),
  ].filter((file) => existsSync(file));
  const stale = sources.filter((file) => statSync(file).mtimeMs > built);
  if (stale.length > 0) {
    console.error(
      'dist/ is older than the sources — run `npm run build` first:\n  ' +
        stale.map((file) => file.slice(ROOT.length + 1)).join('\n  '),
    );
    process.exit(1);
  }
}

/** Three throwaway folders, each with the number of files it was asked for. */
function makeFolders() {
  const root = mkdtempSync(join(tmpdir(), 'infagent-steps-'));
  const names = ['alpha', 'beta', 'gamma'];
  const folders = counts.map((count, index) => {
    const path = join(root, `${names[index % names.length]}-${index + 1}`);
    mkdirSync(path, { recursive: true });
    for (let file = 1; file <= count; file += 1) {
      const name = file % 3 === 0 ? `note-${file}.md` : `sample-${file}.txt`;
      writeFileSync(join(path, name), `file ${file}\n`);
    }
    return { path, count };
  });
  return { root, folders };
}

const { QwenEngine } = await import(DIST);
const engine = new QwenEngine();

const status = engine.status();
if (modelId && modelId !== status.modelId) {
  await engine.useModel(modelId);
}
const current = engine.status();
if (!current.modelPresent) {
  console.error(
    `${current.modelId}: weights are not downloaded (${current.modelPath}).\n` +
      `Download them first:  node dist/cli.js chat download ${current.modelId}`,
  );
  process.exit(1);
}

/** Ask once and record everything the reply did. */
async function runOnce(folders, index) {
  const expected = folders.reduce((total, folder) => total + folder.count, 0);
  const question =
    `List the files in these three folders and count how many files there are: ` +
    `${folders.map((folder) => folder.path).join(', ')}. Give me the total.`;

  const startedAt = Date.now();
  const plans = [];
  const calls = [];
  const lines = [];
  let answer = '';
  let stats = null;
  let error = null;

  // Each run starts from a fresh session, so nothing leaks between attempts.
  engine.resetSession();

  try {
    for await (const event of engine.stream({
      messages: [{ role: 'user', content: question }],
      tools: true,
      net: !offline,
      maxToolIterations: steps,
    })) {
      switch (event.type) {
        case 'plan':
          plans.push(event.text);
          lines.push(`📋 step ${event.step ?? '?'}: ${event.text}`);
          break;
        case 'tool_call':
          calls.push({
            name: event.call.name,
            args: event.call.args,
            ok: null,
            step: plans.length,
          });
          lines.push(`🛠 ${event.call.name}(${JSON.stringify(event.call.args)})`);
          break;
        case 'tool_result': {
          const last = [...calls].reverse().find((call) => call.ok === null);
          if (last) last.ok = event.call.ok !== false;
          const result = event.call.result;
          const kept =
            result && typeof result === 'object'
              ? Object.entries(result)
                  .filter(([, value]) => value === null || typeof value !== 'object')
                  .slice(0, 6)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(' ')
              : String(result ?? '');
          lines.push(`   ${event.call.ok === false ? '✗' : '✓'} ${kept}`);
          break;
        }
        case 'token':
          answer += event.text;
          break;
        case 'reset':
          answer = '';
          break;
        case 'stats':
          stats = event;
          break;
        case 'error':
          error = event.message;
          break;
        default:
          break;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const listed = folders.map((folder) =>
    calls.some(
      (call) => call.name === 'list_files' && JSON.stringify(call.args ?? {}).includes(folder.path),
    ),
  );
  const totalInAnswer = new RegExp(`\\b${expected}\\b`).test(answer);
  const runtimeTotal = /Total across the \d+ results: \d+/.test(answer);
  const honest = answer.trim().length > 0 && error === null && !/\bno files\b/i.test(answer);

  return {
    index,
    question,
    expected,
    plans,
    calls: calls.map((call) => ({ name: call.name, args: call.args, ok: call.ok })),
    answer: answer.trim(),
    transcript: lines,
    stats,
    error,
    listed,
    allListed: listed.every(Boolean),
    totalInAnswer,
    runtimeTotal,
    honest,
    ok: listed.every(Boolean) && (totalInAnswer || runtimeTotal) && honest && error === null,
    durationMs: Date.now() - startedAt,
  };
}

const { root, folders } = makeFolders();
const results = [];
try {
  console.log(
    `model:   ${current.modelId}\n` +
      `folders: ${folders.map((folder) => `${folder.path} (${folder.count} files)`).join('\n         ')}\n` +
      `expect:  ${folders.reduce((total, folder) => total + folder.count, 0)} files in total\n` +
      `steps:   up to ${steps} per reply\n`,
  );

  for (let run = 0; run < runs; run += 1) {
    const result = await runOnce(folders, run + 1);
    results.push(result);
    console.log(`\n── run ${run + 1}/${runs} ──────────────────────────────────────────────`);
    for (const line of result.transcript) console.log(line);
    console.log(`\nanswer: ${result.answer || '(none)'}`);
    if (result.stats) {
      console.log(
        `stats:  ${result.stats.totalTokens} tok · ${result.stats.tokensPerSecond.toFixed(1)} tok/s · ` +
          `${(result.stats.durationMs / 1000).toFixed(1)} s · repairs ${result.stats.repairs ?? 0}`,
      );
    }
    if (result.error) console.log(`error:  ${result.error}`);
    console.log(
      `checks: folders ${result.listed.filter(Boolean).length}/${result.listed.length}` +
        ` · total stated ${result.totalInAnswer ? 'by the model' : result.runtimeTotal ? 'by the runtime' : 'NO'}` +
        ` · calls ${result.calls.length} (${result.calls.filter((call) => call.ok === false).length} failed)` +
        ` · ${result.ok ? 'PASS' : 'FAIL'}`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const passed = results.filter((result) => result.ok).length;
console.log(
  `\n${passed}/${results.length} run(s) passed on ${current.modelId} ` +
    `(steps budget ${steps}, folders ${counts.join('+')} → ${results[0]?.expected ?? '?'} files).`,
);

if (asJson) {
  console.log(JSON.stringify({ model: current.modelId, steps, counts, results }, null, 2));
}

process.exit(passed === results.length ? 0 : 1);

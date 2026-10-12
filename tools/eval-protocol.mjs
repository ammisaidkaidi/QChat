/**
 * Measures the tool protocol, per model, on this machine.
 *
 * The protocol has two switches (see `models/README.md` → *Tool protocol*):
 * the grammar (`INFAGENT_TOOL_GRAMMAR`) and the contract itself
 * (`INFAGENT_TOOL_PROTOCOL`). This script answers the practical question —
 * "does this model do better with the grammar on, and with the envelope at
 * all?" — with numbers instead of taste:
 *
 *   npm run build                       # the script drives the built engine
 *   node dist/cli.js chat download Qwen3-0.6B-Q4_K_M
 *   node tools/eval-protocol.mjs                       # the active model
 *   node tools/eval-protocol.mjs --model xLAM-2-3B-fc-r-Q4_K_M --limit 6 --json
 *
 * It runs the same fixed prompts through the engine once per pass
 * (`strict-json` with the grammar, the same without it, and `legacy` — the old
 * lenient wording) and reports, per pass:
 *
 *   valid   replies that were a correct envelope on the first try
 *   repair  correction turns spent (a parse failure that was recovered)
 *   calls   tool calls emitted, and how many of them failed to run
 *   p50     median seconds per reply
 *
 * Every pass starts from a fresh session (`engine.resetSession()`), but the
 * prompts inside a pass share one conversation, in order — so the history grows
 * the way a real chat does.
 *
 * Nothing here writes to the repository, the weights folder or the settings
 * files: every prompt is read-only (list, read, describe, search, fetch, alert).
 *
 * Options: --model <id>  --limit <n>  --steps <n>  --passes a,b  --offline  --verbose  --json
 */
import { existsSync, statSync } from 'node:fs';
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
const limit = Number(flag('limit', 12));
/** Tool steps a single reply may take; 2 keeps the eval quick. */
const steps = Number(flag('steps', 2));
const offline = Boolean(flag('offline', false));
const verbose = Boolean(flag('verbose', false));
const asJson = Boolean(flag('json', false));
const wanted = String(flag('passes', 'strict-json,no-grammar,legacy'))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

if (!existsSync(DIST)) {
  console.error(
    'dist/ is missing — run `npm run build` first (this script drives the built engine).',
  );
  process.exit(1);
}

// The engine this script drives is the *built* one, so a stale dist/ would
// measure yesterday's protocol. Cheap guard: any source file newer than the
// build means "rebuild first".
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
      'dist/ is older than the sources — run `npm run build` first, otherwise the ' +
        'numbers below describe the previous build:\n  ' +
        stale.map((file) => file.slice(ROOT.length + 1)).join('\n  '),
    );
    process.exit(1);
  }
}

/** The fixed prompt set. Read-only on purpose: nothing here mutates the repo. */
const PROMPTS = [
  { text: 'What scripts do you have?', tool: true },
  { text: 'List my scripts, then describe the one that greets people.', tool: true },
  { text: 'Read the source of the hello script.', tool: true },
  { text: 'Tell me what the system reports about this machine.', tool: true },
  { text: 'Give me a one-sentence summary of https://example.com.', tool: true },
  { text: 'Search the web for the latest llama.cpp release.', tool: true },
  { text: 'Show an alert that says hello from the eval.', tool: true },
  { text: 'Which functions can you call? Do not call any of them.', tool: false },
  { text: 'What is the capital of Japan?', tool: false },
  { text: 'Explain in one sentence what a function call is.', tool: false },
  { text: 'Say thanks in French, one word.', tool: false },
  { text: 'Reply with exactly: ready.', tool: false },
];

const PASSES = {
  'strict-json': { INFAGENT_TOOL_PROTOCOL: 'strict-json', INFAGENT_TOOL_GRAMMAR: '1' },
  'no-grammar': { INFAGENT_TOOL_PROTOCOL: 'strict-json', INFAGENT_TOOL_GRAMMAR: '0' },
  legacy: { INFAGENT_TOOL_PROTOCOL: 'legacy', INFAGENT_TOOL_GRAMMAR: '0' },
};

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

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** One reply: what the engine needed, what it produced, how long it took. */
async function runPrompt(text, index) {
  const startedAt = Date.now();
  const calls = [];
  let stats = null;
  let error = null;
  let answer = '';
  try {
    for await (const event of engine.stream({
      messages: [{ role: 'user', content: text }],
      tools: true,
      net: !offline,
      maxToolIterations: steps,
    })) {
      if (event.type === 'token') answer += event.text;
      else if (event.type === 'tool_call') calls.push({ name: event.call.name, ok: null });
      else if (event.type === 'tool_result') {
        const last = calls[calls.length - 1];
        if (last) last.ok = event.call.ok !== false;
      } else if (event.type === 'stats') stats = event;
      else if (event.type === 'error') error = event.message;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    index,
    prompt: text,
    answer: answer.trim(),
    calls,
    repairs: stats?.repairs ?? 0,
    durationMs: Date.now() - startedAt,
    error,
  };
}

console.log(`model: ${current.modelId} (${current.modelName})`);
console.log(
  `prompts: ${Math.min(PROMPTS.length, Number.isFinite(limit) ? limit : 12)} · steps: ${steps}`,
);
console.log('');

const results = [];
for (const pass of wanted) {
  const env = PASSES[pass];
  if (!env) {
    console.error(`unknown pass "${pass}" — try: ${Object.keys(PASSES).join(', ')}`);
    process.exit(1);
  }
  Object.assign(process.env, env);
  // Each pass is a clean conversation, otherwise pass 2 inherits pass 1's turns.
  engine.resetSession();
  if (verbose) process.env['INFAGENT_CHAT_DEBUG'] = '1';

  const turns = [];
  const list = PROMPTS.slice(0, Number.isFinite(limit) ? limit : PROMPTS.length);
  for (const [index, entry] of list.entries()) {
    const turn = await runPrompt(entry.text, index + 1);
    turns.push(turn);
    if (verbose) {
      const shape = turn.error
        ? `error: ${turn.error}`
        : turn.calls.length > 0
          ? `calls: ${turn.calls.map((call) => call.name).join(', ')}`
          : 'final';
      console.log(
        `  ${pass} ${String(index + 1).padStart(2)}/${list.length}  ${shape}  ` +
          `${turn.repairs} repair  ${(turn.durationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  const summary = {
    pass,
    turns: turns.length,
    valid: turns.filter((turn) => turn.repairs === 0 && !turn.error).length,
    repairs: turns.reduce((total, turn) => total + turn.repairs, 0),
    answered: turns.filter((turn) => turn.answer.length > 0 && !turn.error).length,
    silent: turns.filter((turn) => turn.answer.length === 0 && turn.calls.length === 0).length,
    errors: turns.filter((turn) => turn.error).length,
    calls: turns.reduce((total, turn) => total + turn.calls.length, 0),
    failedCalls: turns.reduce(
      (total, turn) => total + turn.calls.filter((call) => call.ok === false).length,
      0,
    ),
    calledWhenAskedNotTo: turns.filter((turn, index) => !list[index]?.tool && turn.calls.length > 0)
      .length,
    medianMs: Math.round(median(turns.map((turn) => turn.durationMs))),
  };
  results.push(summary);
  console.log(
    `${pass.padEnd(12)} valid ${summary.valid}/${summary.turns}` +
      `  repairs ${summary.repairs}` +
      `  answered ${summary.answered}/${summary.turns}` +
      `  calls ${summary.calls} (${summary.failedCalls} failed)` +
      `  stray ${summary.calledWhenAskedNotTo}` +
      `  silent ${summary.silent}` +
      `  errors ${summary.errors}` +
      `  p50 ${(summary.medianMs / 1000).toFixed(1)}s`,
  );
}

if (asJson) console.log(JSON.stringify({ model: current.modelId, results }, null, 2));

const best = [...results].sort(
  (a, b) => b.valid - a.valid || a.repairs - b.repairs || a.medianMs - b.medianMs,
)[0];
if (best) {
  console.log('');
  console.log(
    `verdict: "${best.pass}" scored highest on this machine ` +
      `(${best.valid}/${best.turns} first-try valid, ${best.repairs} repairs).`,
  );
  console.log(
    'Set it per model in models/<id>.settings.json → toolProtocol, ' +
      'or globally with INFAGENT_TOOL_PROTOCOL.',
  );
}
process.exit(0);

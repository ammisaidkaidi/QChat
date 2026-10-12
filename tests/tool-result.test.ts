/**
 * The tool-result contract, end to end and without a model.
 *
 * The reported bug: the user sent `listscripts`, the log showed
 * `listScripts({})` running and returning six scripts, and the reply said
 * *"There are no scripts available. You need to specify a name…"*.
 *
 * Cause (see the guard below): the "did the answer use the result?" check
 * matched any string from the payload — including the *parameter names* a
 * listing carries (`name`, `path`, `limit`…). The contradictory reply contained
 * the word "name", so the runtime believed it had used the payload and never
 * published the facts. These tests pin every step of that chain.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  answerClaimsEmpty,
  answerEnumerates,
  answerStatesWrongCount,
  asksAboutToolbox,
  answerUsesResult,
  fallbackAnswer,
  guardToolAnswer,
  identifyingValues,
  readableResult,
  resultIsEmpty,
  statedCount,
  toolResultPrompt,
} from '../src/chat/prompt.js';
import { resultEnvelope } from '../src/chat/protocol.js';
import { dispatchTool } from '../src/chat/tools.js';
import { ScriptRegistry } from '../src/scripts/registry.js';

const SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

/** The exact payload `listScripts({})` returned in the report. */
const SIX_SCRIPTS = [
  {
    name: 'disk_report',
    language: 'py',
    description: 'Report free and used disk space for every mounted volume.',
    args: ['min_free_gb'],
  },
  {
    name: 'hello',
    language: 'js',
    description: 'Greet a person by name and report the runtime that executed it.',
    args: ['name', 'shout'],
  },
  {
    name: 'list_files',
    language: 'py',
    description:
      'List files in a folder with size, type and modification time, optionally recursive.',
    args: ['path', 'pattern', 'recursive', 'hidden', 'dirs', 'sort', 'limit', 'depth'],
  },
  {
    name: 'net_interfaces',
    language: 'py',
    description:
      'List the network interfaces with their state, addresses, traffic counters and the default route.',
    args: ['addresses', 'traffic', 'down', 'name'],
  },
  {
    name: 'screen_shot',
    language: 'js',
    description:
      'Capture the screen (or a web page when there is no display) and save it into ./screenshot/.',
    args: ['out', 'name', 'url', 'full', 'width', 'height', 'display', 'keep'],
  },
  {
    name: 'system_info',
    language: 'py',
    description: 'Report system properties: CPU, memory, disks, uptime, load and temperature.',
    args: ['disks', 'cpu_load', 'sample_ms', 'top_processes'],
  },
];

const CONTRADICTION =
  'There are no scripts available. You need to specify a name, or select from the list of scripts, to proceed.';

const NAMES = SIX_SCRIPTS.map((script) => script.name);

describe('Test A — a non-empty list survives a contradictory reply', () => {
  it('does not count the payload’s parameter names as using the result', () => {
    // `name`, `path`, `limit`… are what the listing *describes*, not what it
    // *contains*. This was the false positive that hid the real answer.
    expect(answerUsesResult(CONTRADICTION, SIX_SCRIPTS)).toBe(false);
    expect(answerUsesResult('You have no scripts.', SIX_SCRIPTS)).toBe(false);
    expect(answerUsesResult('The scripts are hello and disk_report.', SIX_SCRIPTS)).toBe(true);
  });

  it('replaces the contradiction with the facts', () => {
    const action = guardToolAnswer(CONTRADICTION, {
      name: 'listScripts',
      ok: true,
      result: SIX_SCRIPTS,
    });

    expect(action.kind).toBe('replace');
    const text = action.kind === 'none' ? '' : action.text;
    for (const name of NAMES) expect(text, name).toContain(name);
    expect(text.toLowerCase()).not.toContain('no scripts available');
  });

  it('keeps the model’s answer when it did use the payload', () => {
    const answer =
      'You have 6 scripts: disk_report, hello, list_files, net_interfaces, screen_shot and system_info.';
    expect(
      guardToolAnswer(answer, { name: 'listScripts', ok: true, result: SIX_SCRIPTS }).kind,
    ).toBe('none');
  });

  it('corrects a count the payload contradicts', () => {
    const wrong = guardToolAnswer('You have three scripts: hello, disk_report and list_files.', {
      name: 'listScripts',
      ok: true,
      result: SIX_SCRIPTS,
    });
    expect(wrong.kind).toBe('replace');
    if (wrong.kind === 'replace') {
      for (const name of NAMES) expect(wrong.text).toContain(name);
    }

    // The right count is a use of the payload, even without repeating a name.
    expect(
      guardToolAnswer('You have 6 scripts.', { name: 'listScripts', ok: true, result: SIX_SCRIPTS })
        .kind,
    ).toBe('none');
    expect(statedCount('six scripts are registered')).toBe(6);
    expect(statedCount('the scripts are hello and disk_report')).toBeNull();
    expect(answerStatesWrongCount('You have three scripts.', 6)).toBe(true);
    expect(answerStatesWrongCount('You have three scripts.', 3)).toBe(false);
  });

  it('corrects an enumerating answer that names only some of them', () => {
    const partial = guardToolAnswer(
      'The available scripts are hello, system_info, and net_interfaces.',
      { name: 'listScripts', ok: true, result: SIX_SCRIPTS },
    );
    expect(partial.kind).toBe('replace');
    if (partial.kind === 'replace') for (const name of NAMES) expect(partial.text).toContain(name);

    // A sentence about one item is not an enumeration of the list.
    expect(
      guardToolAnswer('disk_report reports free and used disk space.', {
        name: 'listScripts',
        ok: true,
        result: SIX_SCRIPTS,
      }).kind,
    ).toBe('none');
    // And the full enumeration is left alone.
    expect(
      guardToolAnswer(
        'The scripts are disk_report, hello, list_files, net_interfaces, screen_shot and system_info.',
        { name: 'listScripts', ok: true, result: SIX_SCRIPTS },
      ).kind,
    ).toBe('none');
    expect(answerEnumerates('The available scripts are hello.')).toBe(true);
    expect(answerEnumerates('disk_report reports disk space.')).toBe(false);
  });

  it('adds the facts under a reply that ignored them', () => {
    const action = guardToolAnswer('I have several scripts available.', {
      name: 'listScripts',
      ok: true,
      result: SIX_SCRIPTS,
    });
    expect(action.kind).toBe('append');
    if (action.kind === 'append') expect(action.text).toContain('disk_report');
  });
});

describe('Test B — an empty list is the only source of “none”', () => {
  it('renders the authoritative empty', () => {
    expect(resultIsEmpty([])).toBe(true);
    expect(resultIsEmpty({})).toBe(true);
    expect(resultIsEmpty(null)).toBe(true);
    expect(resultIsEmpty([])).toBe(true);
    expect(resultIsEmpty(SIX_SCRIPTS)).toBe(false);
    expect(fallbackAnswer('listScripts', [])).toBe('listScripts → no scripts found.');
  });

  it('fills an empty reply with the empty-result line', () => {
    const action = guardToolAnswer('', { name: 'listScripts', ok: true, result: [] });
    expect(action.kind).toBe('replace');
    if (action.kind === 'replace') expect(action.text).toBe('listScripts → no scripts found.');
  });

  it('leaves a correct “none” alone', () => {
    expect(
      guardToolAnswer('You do not have any scripts installed.', {
        name: 'listScripts',
        ok: true,
        result: [],
      }).kind,
    ).toBe('none');
    expect(answerClaimsEmpty('There are no scripts available.')).toBe(true);
    expect(answerClaimsEmpty('I found hello and disk_report.')).toBe(false);
  });
});

describe('Test C — a failure is never an empty list', () => {
  it('names the failure', () => {
    const text = fallbackAnswer('listScripts', { ok: false, error: 'registry unreadable' });
    expect(text).toBe('listScripts → failed: registry unreadable');
    expect(text).not.toMatch(/no scripts/i);
  });

  it('publishes a failure the reply hid', () => {
    const action = guardToolAnswer('All done.', {
      name: 'listScripts',
      ok: false,
      error: 'registry unreadable',
    });
    expect(action.kind).toBe('append');
    if (action.kind === 'append') expect(action.text).toContain('registry unreadable');
  });

  it('replaces a reply that turns a failure into “none”', () => {
    const action = guardToolAnswer('You have no scripts.', {
      name: 'listScripts',
      ok: false,
      error: 'registry unreadable',
    });
    expect(action.kind).toBe('replace');
    if (action.kind === 'replace') expect(action.text).not.toMatch(/no scripts/i);
  });

  it('accepts a reply that reports the failure itself', () => {
    expect(
      guardToolAnswer('The registry could not be read, so I cannot list the scripts.', {
        name: 'listScripts',
        ok: false,
        error: 'registry unreadable',
      }).kind,
    ).toBe('none');
  });
});

describe('Test D — wrapped and serialized results', () => {
  it('reads the identifiers through the `{ok, result}` envelope', () => {
    expect(identifyingValues({ ok: true, result: SIX_SCRIPTS })).toEqual(NAMES);
    expect(resultIsEmpty({ ok: true, result: [] })).toBe(true);
    expect(answerUsesResult(CONTRADICTION, { ok: true, result: SIX_SCRIPTS })).toBe(false);
  });

  it('gives the model both the envelope and a readable copy', () => {
    const payload = resultEnvelope([{ name: 'listScripts', ok: true, result: SIX_SCRIPTS }]);
    const rendered = readableResult(SIX_SCRIPTS);
    const prompt = toolResultPrompt([`listScripts → ${rendered}`], 'listscripts', {
      envelope: payload,
    });

    const first = JSON.parse(prompt.split('\n')[0] ?? '{}');
    expect(first.type).toBe('tool_result');
    expect(first.calls[0].name).toBe('listScripts');
    expect(first.calls[0].ok).toBe(true);
    expect(first.calls[0].result).toHaveLength(6);

    expect(prompt).toContain('readable copy');
    for (const name of NAMES) expect(prompt).toContain(name);
    // The instruction has to forbid both wrong directions.
    expect(prompt).toContain('reply with the "final" object');
    expect(prompt).toMatch(/never say a tool returned nothing/i);
  });

  it('renders a list as names first, not as nested JSON', () => {
    const rendered = readableResult(SIX_SCRIPTS);
    expect(rendered).toContain('disk_report — Report free and used disk space');
    expect(rendered).not.toContain('{');
  });
});

describe('Test E — the result stays correlated with its call', () => {
  it('injects the call name, the outcome and the payload in one object', () => {
    const dispatchedOutcome = { name: 'listScripts', ok: true, result: SIX_SCRIPTS };
    const parsed = JSON.parse(resultEnvelope([dispatchedOutcome])) as {
      type: string;
      calls: { name: string; ok: boolean; result: unknown }[];
    };

    expect(parsed.type).toBe('tool_result');
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls[0]?.name).toBe(dispatchedOutcome.name);
    expect(parsed.calls[0]?.ok).toBe(true);
    expect(parsed.calls[0]?.result).toEqual(SIX_SCRIPTS);
  });

  it('keeps a failure correlated too, as an error instead of a result', () => {
    const parsed = JSON.parse(
      resultEnvelope([{ name: 'listScripts', ok: false, error: 'boom' }]),
    ) as {
      calls: { name: string; ok: boolean; result?: unknown; error?: string }[];
    };
    expect(parsed.calls[0]).toEqual({ name: 'listScripts', ok: false, error: 'boom' });
  });
});

describe('the reported wording is recognised as a toolbox question', () => {
  it('treats a bare tool-name command as “list the scripts”', () => {
    for (const text of ['listscripts', 'list scripts', 'list_scripts', 'ls scripts']) {
      expect(asksAboutToolbox(text), text).toBe(true);
    }
  });

  it('leaves other requests and definitions alone', () => {
    for (const text of ['list files', 'I have no scripts', 'what is a function call']) {
      expect(asksAboutToolbox(text), text).toBe(false);
    }
  });
});

describe('Test F — the reported request, through the real registry', () => {
  it('runs `listscripts` against the actual toolbox and answers with the scripts', async () => {
    const registry = new ScriptRegistry({ root: SCRIPTS_DIR });
    const dispatched = await dispatchTool({ name: 'listScripts', args: {} }, { registry });

    // 1. the call itself still works
    expect(dispatched.ok).toBe(true);
    const listed = dispatched.result as { name: string }[];
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.length).toBeGreaterThanOrEqual(5);
    expect(listed.map((script) => script.name)).toContain('hello');

    // 2. the result reaches the model in the shape the protocol defines
    const prompt = toolResultPrompt([`listScripts → ${readableResult(listed)}`], 'listscripts', {
      envelope: resultEnvelope([{ name: 'listScripts', ok: true, result: listed }]),
    });
    for (const script of listed) expect(prompt).toContain(script.name);

    // 3. and a reply that denies the list is replaced by it
    const answer = guardToolAnswer(CONTRADICTION, {
      name: 'listScripts',
      ok: true,
      result: listed,
    });
    expect(answer.kind).toBe('replace');
    const finalText = answer.kind === 'none' ? '' : answer.text;
    for (const script of listed) expect(finalText).toContain(script.name);
    expect(finalText.toLowerCase()).not.toContain('there are no scripts');
  });

  it('distinguishes an empty registry from a broken one', async () => {
    const empty = new ScriptRegistry({ root: mkdtempSync(join(tmpdir(), 'infagent-empty-')) });
    const listed = await dispatchTool({ name: 'listScripts', args: {} }, { registry: empty });
    expect(listed.ok).toBe(true);
    expect(listed.result).toEqual([]);
    expect(fallbackAnswer('listScripts', listed.result)).toBe('listScripts → no scripts found.');

    const failing = await dispatchTool({ name: 'notATool', args: {} }, { registry: empty });
    expect(failing.ok).toBe(false);
    // An error must never be rendered as an empty list.
    expect(fallbackAnswer('notATool', { ok: false, error: failing.error })).toMatch(/failed:/);
  });
});

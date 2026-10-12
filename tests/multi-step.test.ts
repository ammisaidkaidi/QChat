import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STEPS,
  finalOnlyGrammarSchema,
  parseEnvelope,
  stepBudget,
} from '../src/chat/protocol.js';
import {
  type MergedFact,
  compactResult,
  fallbackAnswer,
  filteredCount,
  finalAnswerPrompt,
  guardToolAnswer,
  mergedTotal,
  multiStepSpec,
  progressPrompt,
  toolResultPrompt,
  totalLine,
  unusedRequestPaths,
} from '../src/chat/prompt.js';

const TOOLS = ['list_files', 'system_info'];

/** The shape `list_files` prints for one folder. */
function folder(path: string, files: number): unknown {
  return {
    ok: true,
    result: {
      path,
      recursive: false,
      sort: 'name',
      count: files,
      scanned: files,
      unreadable_folders: 0,
      truncated: false,
      totals: { files, directories: 0, size_bytes: files * 1024 },
      entries: Array.from({ length: files }, (_, index) => ({
        name: `file-${index}.txt`,
        relative: `file-${index}.txt`,
        type: 'file',
      })),
    },
  };
}

describe('step budget', () => {
  it('allows several steps by default', () => {
    expect(stepBudget()).toBe(DEFAULT_STEPS);
    expect(DEFAULT_STEPS).toBeGreaterThanOrEqual(4);
  });

  it('honours the request and clamps to a sane range', () => {
    expect(stepBudget(3)).toBe(3);
    expect(stepBudget(0)).toBe(1);
    expect(stepBudget(99)).toBe(12);
    expect(stepBudget(2.6)).toBe(3);
  });

  it('reads INFAGENT_MAX_STEPS, while the request still wins', () => {
    process.env['INFAGENT_MAX_STEPS'] = '9';
    try {
      expect(stepBudget()).toBe(9);
      expect(stepBudget(4)).toBe(4);
    } finally {
      delete process.env['INFAGENT_MAX_STEPS'];
    }
  });
});

describe('the multi-step instruction', () => {
  it('states the budget and the plan-then-merge way of working', () => {
    const spec = multiStepSpec(6).join('\n');
    expect(spec).toContain('at most 6 steps');
    expect(spec).toMatch(/one list_files step per folder/i);
    expect(spec).toContain('never invented');
    // A small model follows an example far better than a rule.
    expect(spec).toMatch(/example/i);
    expect(spec).toContain('no pattern or filter of your own');
  });

  it('follows the number it is given', () => {
    expect(multiStepSpec(3).join('\n')).toContain('at most 3 steps');
  });
});

describe('a plan on the envelope', () => {
  it('is kept when the model states one', () => {
    const result = parseEnvelope(
      '{"type":"tool_call","plan":"List the first folder","calls":[{"name":"list_files","arguments":{"path":"/tmp/a"}}]}',
      { toolNames: TOOLS },
    );
    expect(result.ok && result.envelope.type === 'tool_call' && result.envelope.plan).toBe(
      'List the first folder',
    );
  });

  it('may be absent, and is trimmed and capped when long', () => {
    const none = parseEnvelope('{"type":"tool_call","calls":[{"name":"list_files"}]}', {
      toolNames: TOOLS,
    });
    expect(none.ok && none.envelope.type === 'tool_call' && none.envelope.plan).toBeUndefined();

    const long = parseEnvelope(
      JSON.stringify({
        type: 'tool_call',
        plan: `  ${'x'.repeat(400)}  `,
        calls: [{ name: 'list_files' }],
      }),
      { toolNames: TOOLS },
    );
    const plan = long.ok && long.envelope.type === 'tool_call' ? (long.envelope.plan ?? '') : '';
    expect(plan.startsWith('x')).toBe(true);
    expect(plan.endsWith(' ')).toBe(false);
    expect(plan.length).toBeLessThanOrEqual(240);
  });

  it('is rejected when it is not text', () => {
    const result = parseEnvelope('{"type":"tool_call","plan":[],"calls":[{"name":"list_files"}]}', {
      toolNames: TOOLS,
    });
    expect(result.ok).toBe(false);
  });
});

describe('the last turn of a spent reply', () => {
  it('offers only the final object, so no further call can be opened', () => {
    expect(finalOnlyGrammarSchema()).toEqual({
      type: 'object',
      properties: { type: { const: 'final' }, content: { type: 'string' } },
    });
  });

  it('asks for the answer and the computed total', () => {
    const prompt = finalAnswerPrompt('how many files in total?', 'Progress so far:\nstep 1 · x');
    expect(prompt).toContain('how many files in total?');
    expect(prompt).toContain('step 1 · x');
    expect(prompt).toContain('no further tool call');
    expect(prompt).toContain('compute it from those results');
  });
});

describe('what a finished step leaves behind', () => {
  it('keeps the numbers of a folder listing, not its entries', () => {
    const line = compactResult(folder('/tmp/a', 3));
    expect(line).toContain('count: 3');
    expect(line).toContain('totals.files: 3');
    expect(line).toContain('path: /tmp/a');
  });

  it('summarises a list of names', () => {
    const line = compactResult([
      { name: 'hello.js' },
      { name: 'disk_report.py' },
      { name: 'list_files.py' },
    ]);
    expect(line).toBe('3 items: hello.js, disk_report.py, list_files.py');
  });

  it('says what a scalar result is', () => {
    expect(compactResult('done')).toBe('done');
    expect(compactResult(null)).toBe('none');
  });
});

describe('the running list of steps', () => {
  it('names each call with the numbers it returned', () => {
    const prompt = progressPrompt([
      { step: 1, call: 'list_files({"/tmp/a"})', result: folder('/tmp/a', 3) },
      { step: 2, call: 'list_files({"/tmp/b"})', result: folder('/tmp/b', 4) },
    ]);
    expect(prompt).toContain('step 1 · list_files({"/tmp/a"}) → count: 3');
    expect(prompt).toContain('step 2 · list_files({"/tmp/b"}) → count: 4');
  });

  it('keeps the tail and says what it dropped', () => {
    const entries = Array.from({ length: 14 }, (_, index) => ({
      step: index + 1,
      call: `call${index + 1}()`,
      result: { count: index + 1 },
    }));
    const prompt = progressPrompt(entries);
    expect(prompt).toContain('call14()');
    expect(prompt).not.toContain('call1()');
    expect(prompt).toContain('the first 4 step(s) are in the conversation above');
  });

  it('is empty before the first step', () => {
    expect(progressPrompt([])).toBe('');
  });
});

/** Three steps that listed three folders: the shape of the counting task. */
function listed(counts: number[]): MergedFact[] {
  return counts.map((files, index) => ({
    tool: 'list_files',
    args: JSON.stringify({ path: `/tmp/folder-${index + 1}` }),
    ok: true,
    result: folder(`/tmp/folder-${index + 1}`, files),
  }));
}

describe('adding up the steps of a reply', () => {
  it('sums the same number of every payload', () => {
    expect(mergedTotal(listed([3, 4, 6]))).toEqual({
      tool: 'list_files',
      key: 'totals.files',
      total: 13,
      parts: 3,
    });
  });

  it('counts one folder once, however often it was listed', () => {
    const facts = listed([3, 4]);
    facts.push({ ...facts[0]! });
    const merged = mergedTotal(facts);
    expect(merged?.parts).toBe(2);
    expect(merged?.total).toBe(7);
  });

  it('counts a folder once even when the second call used other arguments', () => {
    const facts = listed([3, 4]);
    // The same folder again, this time with junk arguments the model invented.
    facts.push({
      tool: 'list_files',
      args: JSON.stringify({ path: '/tmp/folder-1', recursive: false, count: 1 }),
      ok: true,
      result: folder('/tmp/folder-1', 3),
    });
    const merged = mergedTotal(facts);
    expect(merged?.parts).toBe(2);
    expect(merged?.total).toBe(7);
  });

  it('has nothing to add up for a single step', () => {
    expect(mergedTotal(listed([3]))).toBeNull();
  });

  it('refuses a total when a step failed or a listing was cut short', () => {
    const withFailure = listed([3, 6]);
    withFailure.splice(1, 0, {
      tool: 'list_files',
      args: JSON.stringify({ path: '/tmp/missing' }),
      ok: false,
      result: 'folder not found',
    });
    expect(mergedTotal(withFailure)).toBeNull();

    const withPartial = listed([3, 4]);
    (withPartial[1]!.result as { result: { truncated: boolean } }).result.truncated = true;
    expect(mergedTotal(withPartial)).toBeNull();
  });

  it('does not mix two different tools', () => {
    const facts = [...listed([3, 4])];
    facts[1]!.tool = 'system_info';
    expect(mergedTotal(facts)).toBeNull();
  });

  it('words the total the way the answer should', () => {
    expect(totalLine({ key: 'totals.files', total: 13, parts: 3 })).toBe(
      'Total across the 3 results: 13 files.',
    );
  });
});

describe('the guard over several steps', () => {
  const last = (facts: MergedFact[]) => ({
    name: facts[facts.length - 1]!.tool,
    ok: true,
    result: facts[facts.length - 1]!.result,
  });
  const question = 'list the files in the three folders and count how many files there are';

  it('accepts an answer that states the computed total', () => {
    const facts = listed([3, 4, 6]);
    const answer = 'Folder 1 has 3 files, folder 2 has 4 and folder 3 has 6 — 13 files in total.';
    expect(guardToolAnswer(answer, last(facts), { facts, question })).toEqual({ kind: 'none' });
  });

  it('replaces an answer whose own total is wrong', () => {
    const facts = listed([3, 4, 6]);
    const guard = guardToolAnswer('The three folders hold 9 files in total.', last(facts), {
      facts,
      question,
    });
    expect(guard.kind).toBe('replace');
    expect(guard.kind === 'replace' && guard.text).toContain('13 files');
  });

  it('replaces a total stated with the number in words', () => {
    const facts = listed([3, 4, 6]);
    const answer = 'The three folders hold fifteen files altogether.';
    const guard = guardToolAnswer(answer, last(facts), { facts, question });
    expect(guard.kind).toBe('replace');
    expect(guard.kind === 'replace' && guard.text).toContain('13 files');
  });

  it('appends the total when the answer leaves it out', () => {
    const facts = listed([3, 4, 6]);
    const answer = 'Folder 1 has 3 files, folder 2 has 4 files and folder 3 has 6 files.';
    const guard = guardToolAnswer(answer, last(facts), { facts, question });
    expect(guard).toEqual({ kind: 'append', text: 'Total across the 3 results: 13 files.' });
  });

  it('leaves the total alone when the user did not ask for one', () => {
    const facts = listed([3, 4, 6]);
    const answer = 'Folder 1 has 3 files, folder 2 has 4 files and folder 3 has 6 files.';
    const guard = guardToolAnswer(answer, last(facts), { facts, question: 'what is in them?' });
    expect(guard).toEqual({ kind: 'none' });
  });

  it('corrects an answer that denies the files of an earlier step', () => {
    const facts = listed([3, 4, 6]);
    const denials = [
      'There are no files in those folders.',
      'No files were found.',
      'The folders appear to be empty.',
    ];
    for (const denial of denials) {
      const guard = guardToolAnswer(denial, last(facts), { facts, question });
      expect(guard.kind, denial).toBe('replace');
    }
  });

  it('says so when a step failed and the answer is silent about it', () => {
    const facts = listed([3, 6]);
    facts.splice(1, 0, {
      tool: 'list_files',
      args: JSON.stringify({ path: '/tmp/missing' }),
      ok: false,
      result: 'folder not found',
    });
    const answer = 'Folder 1 has 3 files and folder 3 has 6 files.';
    const guard = guardToolAnswer(answer, last(facts), { facts, question });
    expect(guard).toEqual({ kind: 'append', text: 'list_files → failed: folder not found' });
  });

  it('appends the facts when a multi-step reply used none of the results', () => {
    const facts = listed([3, 4, 6]);
    const guard = guardToolAnswer('I have listed the folders for you.', last(facts), {
      facts,
      question,
    });
    expect(guard.kind).toBe('append');
    expect(guard.kind === 'append' && guard.text).toContain('13 files');
  });

  it('reads a faithful summary that repeats only the numbers', () => {
    const facts = listed([3, 4, 6]);
    const answer = 'Folder 1: 3 files. Folder 2: 4 files. Folder 3: 6 files. 13 in total.';
    expect(guardToolAnswer(answer, last(facts), { facts, question })).toEqual({ kind: 'none' });
  });

  it('stays quiet when the answer already mentions the failure', () => {
    const facts = listed([3, 6]);
    facts.splice(1, 0, {
      tool: 'list_files',
      args: JSON.stringify({ path: '/tmp/missing' }),
      ok: false,
      result: 'folder not found',
    });
    const answer =
      'Folder 1 has 3 files, folder 2 could not be read (folder not found), folder 3 has 6 files.';
    expect(guardToolAnswer(answer, last(facts), { facts, question: 'what is in them?' }).kind).toBe(
      'none',
    );
  });
});

/** A listing a pattern emptied: nothing matched, but nothing was empty either. */
function filtered(path: string, scanned: number): MergedFact {
  return {
    tool: 'list_files',
    args: JSON.stringify({ path, pattern: '.*' }),
    ok: true,
    result: {
      ok: true,
      result: { path, pattern: '.*', count: 0, scanned, filtered_out: scanned },
    },
  };
}

describe('a listing a filter emptied', () => {
  it('is not the same as an empty folder', () => {
    expect(filteredCount(filtered('/tmp/a', 3).result)).toBe(3);
    expect(filteredCount(folder('/tmp/a', 3))).toBe(0);
    expect(fallbackAnswer('list_files', filtered('/tmp/a', 3).result)).toContain(
      '3 of the 3 entries were kept out by the filter',
    );
  });

  it('cannot be added up into a total', () => {
    expect(mergedTotal([filtered('/tmp/a', 3), filtered('/tmp/b', 4)])).toBeNull();
  });

  it('replaces an answer that reports the filtered zero as a result', () => {
    const fact = filtered('/tmp/a', 3);
    const guard = guardToolAnswer(
      'The total number of files is 0.',
      { name: 'list_files', ok: true, result: fact.result },
      {
        question: 'how many files are in /tmp/a?',
      },
    );
    expect(guard.kind).toBe('replace');
    expect(guard.kind === 'replace' && guard.text).toContain('kept out by the filter');
  });

  it('lets an answer that mentions the filter stand', () => {
    const fact = filtered('/tmp/a', 3);
    const answer = 'Nothing matched the pattern .* — all 3 entries were filtered out.';
    expect(
      guardToolAnswer(
        answer,
        { name: 'list_files', ok: true, result: fact.result },
        {
          question: 'how many files are in /tmp/a?',
        },
      ).kind,
    ).toBe('none');
  });
});

describe('the paths a reply has not used yet', () => {
  it('keeps the ones no call has touched, in the order the user gave them', () => {
    const question = 'list the files in /tmp/a, /tmp/b and /tmp/c and count them';
    expect(unusedRequestPaths(question, ['{"path":"/tmp/a"}'])).toEqual(['/tmp/b', '/tmp/c']);
  });

  it('understands a Windows path', () => {
    const question = 'what is inside D:\\dev\\QChat\\ui and D:\\dev\\QChat\\scripts?';
    expect(unusedRequestPaths(question, [])).toEqual([
      'D:\\dev\\QChat\\ui',
      'D:\\dev\\QChat\\scripts',
    ]);
  });

  it('ignores trailing punctuation and repeats', () => {
    expect(unusedRequestPaths('check /tmp/a, then /tmp/a.', [])).toEqual(['/tmp/a']);
  });

  it('has nothing to say when the request names no path', () => {
    expect(unusedRequestPaths('how many scripts do I have?', [])).toEqual([]);
  });

  it('says which paths are left in the next prompt', () => {
    const prompt = toolResultPrompt(['list_files → count: 3'], 'count /tmp/a and /tmp/b', {
      envelope: '{"type":"tool_result"}',
      remaining: ['/tmp/b'],
    });
    expect(prompt).toContain('Paths in the request that no call has used yet: /tmp/b');
    expect(prompt).toMatch(/not finished until each of them/i);
  });
});

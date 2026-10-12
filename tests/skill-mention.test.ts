/**
 * `/skill` in the message box: the completion list, and what picking one does.
 *
 * Two things have to agree, and both are checked here: the text editing (which
 * word the list filters on, what Enter writes, what Esc removes) and the turn
 * that comes out of it (which skills the message attaches, and the fact that
 * their steps reach the prompt — not just the model's memory of a slash).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyMention,
  attachedSkills,
  dropMention,
  filterSkills,
  mentionAt,
} from '../ui/src/mentions.js';
import { SkillRegistry, DEFAULT_ATTACHED_SKILLS } from '../src/skills/registry.js';
import { buildSystemPrompt } from '../src/chat/prompt.js';

const SKILLS = [
  { meta: { name: 'web-research', description: 'Research with sources.', when: 'Current facts.' } },
  {
    meta: { name: 'repo-search', description: 'Find code in a repository.', when: 'Code search.' },
  },
  { meta: { name: 'git-ship', description: 'Commit and push.', when: 'Shipping.' } },
  {
    meta: { name: 'sqlite-inspection', description: 'Inspect a database.', when: 'DB questions.' },
  },
];

describe('mentionAt', () => {
  it('finds the `/word` the caret sits in', () => {
    expect(mentionAt('hello /we', 9)).toEqual({ start: 6, end: 9, query: 'we' });
  });

  it('treats a bare `/` as an empty query — the whole list', () => {
    expect(mentionAt('/', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(mentionAt('ask /', 5)).toEqual({ start: 4, end: 5, query: '' });
  });

  it('opens anywhere in the text: after a space, a newline, or the start', () => {
    expect(mentionAt('/web', 4)?.start).toBe(0);
    expect(mentionAt('hi /re', 6)?.start).toBe(3);
    expect(mentionAt('one\ntwo\n/sq', 11)?.start).toBe(8);
  });

  it('leaves ordinary slashes alone', () => {
    // A fraction, a path, a URL: none of these are a mention.
    expect(mentionAt('1/2', 3)).toBeNull();
    expect(mentionAt('see skills/web.md', 18)).toBeNull();
    expect(mentionAt('https://example.com/a', 21)).toBeNull();
  });

  it('closes as soon as the word is finished', () => {
    // The caret passed a space: `/web` is part of the sentence now, not a query.
    expect(mentionAt('/web ', 5)).toBeNull();
    expect(mentionAt('/web and more', 13)).toBeNull();
  });

  it('keeps the whole word when the caret is inside it', () => {
    // Esc has to remove the word the user can see, not just the part before the caret.
    expect(mentionAt('/sqlite rest', 4)).toEqual({ start: 0, end: 7, query: 'sql' });
  });

  it('uses the mention nearest the caret, not the first one', () => {
    expect(mentionAt('/a /b', 5)).toEqual({ start: 3, end: 5, query: 'b' });
  });
});

describe('filterSkills', () => {
  it('matches anywhere in the name, ignoring case', () => {
    expect(filterSkills(SKILLS, 'RES').map((skill) => skill.name)).toEqual(['web-research']);
    expect(filterSkills(SKILLS, 'search').map((skill) => skill.name)).toEqual([
      'repo-search',
      'web-research',
    ]);
  });

  it('puts a name that starts with the query first', () => {
    const names = filterSkills(SKILLS, 'sqlite').map((skill) => skill.name);
    expect(names[0]).toBe('sqlite-inspection');
    // `repo-search` also contains the letters, but not at the start.
    expect(filterSkills(SKILLS, 'repo')[0]?.name).toBe('repo-search');
  });

  it('lists everything for a bare `/`, and no more than the limit', () => {
    // The list scrolls, so a bare slash shows the whole catalogue rather than
    // hiding the skill whose name the user has not thought of yet.
    expect(filterSkills(SKILLS, '')).toHaveLength(4);
    expect(filterSkills(SKILLS, '', 2)).toHaveLength(2);
  });

  it('carries the description so a row can explain itself', () => {
    expect(filterSkills(SKILLS, 'git')[0]).toMatchObject({
      name: 'git-ship',
      description: 'Commit and push.',
    });
  });

  it('returns nothing when nothing matches, so the list can stay shut', () => {
    expect(filterSkills(SKILLS, 'zzz')).toEqual([]);
  });
});

describe('picking and dismissing', () => {
  it('replaces the typed word with the full name and a space', () => {
    const mention = mentionAt('do this /sql', 12);
    expect(mention).not.toBeNull();
    const edit = applyMention('do this /sql', mention!, 'sqlite-inspection');
    expect(edit.text).toBe('do this /sqlite-inspection ');
    expect(edit.caret).toBe(edit.text.length);
  });

  it('keeps what follows the mention', () => {
    const mention = mentionAt('/web and more', 4);
    const edit = applyMention('/web and more', mention!, 'web-research');
    expect(edit.text).toBe('/web-research and more');
    // No doubled space: the tail already starts with one.
    expect(edit.caret).toBe('/web-research'.length);
  });

  it('adds the space when the mention is the last thing typed', () => {
    const edit = applyMention('/web', mentionAt('/web', 4)!, 'web-research');
    expect(edit.text).toBe('/web-research ');
    expect(edit.caret).toBe('/web-research '.length);
  });

  it('Esc removes the `/` and the word, and puts the caret where they were', () => {
    const mention = mentionAt('please /web', 11);
    const edit = dropMention('please /web', mention!);
    expect(edit.text).toBe('please ');
    expect(edit.caret).toBe(7);
  });

  it('Esc removes the whole word even from inside it', () => {
    const mention = mentionAt('/sqlite rest', 4);
    const edit = dropMention('/sqlite rest', mention!);
    expect(edit.text).toBe(' rest');
    expect(edit.caret).toBe(0);
  });

  it('Esc does not leave a doubled space behind', () => {
    const mention = mentionAt('run /git now', 8);
    const edit = dropMention('run /git now', mention!);
    expect(edit.text).toBe('run now');
  });

  it('Esc on the only line leaves the box empty', () => {
    const mention = mentionAt('/', 1);
    expect(dropMention('/', mention!).text).toBe('');
  });
});

describe('attachedSkills', () => {
  const known = SKILLS.map((skill) => skill.meta.name);

  it('reads the mentions back out of the message', () => {
    expect(attachedSkills('/web-research find the price of X', known)).toEqual(['web-research']);
    expect(attachedSkills('/git-ship then /sqlite-inspection', known)).toEqual([
      'git-ship',
      'sqlite-inspection',
    ]);
  });

  it('attaches a mention typed after a newline or mid-sentence', () => {
    expect(attachedSkills('one\ntwo\n/web-research please', known)).toEqual(['web-research']);
  });

  it('ignores a slash that is not a known skill', () => {
    // A half-typed word, a path, a fraction: nothing is attached by accident.
    expect(attachedSkills('/web a path skills/web.md and 1/2', known)).toEqual([]);
  });

  it('ignores a repeated mention and matches case-insensitively', () => {
    expect(attachedSkills('/WEB-Research and /web-research', known)).toEqual(['web-research']);
  });

  it('does not treat a deleted mention as still attached', () => {
    const dropped = dropMention('run /git now', mentionAt('run /git now', 8)!);
    expect(attachedSkills(dropped.text, known)).toEqual([]);
  });

  it('attaches a name followed by punctuation', () => {
    expect(attachedSkills('please /git-ship.', known)).toEqual(['git-ship']);
  });
});

describe('the skill body reaches the prompt', () => {
  function scratchRegistry(): SkillRegistry {
    const root = mkdtempSync(join(tmpdir(), 'infagent-skill-pin-'));
    mkdirSync(root, { recursive: true });
    for (const skill of SKILLS) {
      writeFileSync(
        join(root, `${skill.meta.name}.md`),
        `---\nname: ${skill.meta.name}\ndescription: ${skill.meta.description}\nwhen: ${skill.meta.when}\n---\n\n# ${skill.meta.name}\n\n1. Step one of ${skill.meta.name}.\n`,
        'utf8',
      );
    }
    return new SkillRegistry({ root });
  }

  it('loads the named skills, in order, with their bodies', () => {
    const loaded = scratchRegistry().load(['git-ship', 'web-research']);
    expect(loaded.map((skill) => skill.name)).toEqual(['git-ship', 'web-research']);
    expect(loaded[0]?.body).toContain('Step one of git-ship.');
    expect(loaded[0]?.truncated).toBe(false);
  });

  it('skips a skill that no longer exists instead of failing the turn', () => {
    const loaded = scratchRegistry().load(['gone-since', 'git-ship']);
    expect(loaded.map((skill) => skill.name)).toEqual(['git-ship']);
  });

  it('refuses a name that is not a plain skill name', () => {
    expect(scratchRegistry().load(['../escape', 'a/b'])).toEqual([]);
  });

  it('stops at the cap and cuts a body that is too long', () => {
    const registry = scratchRegistry();
    expect(registry.load(SKILLS.map((skill) => skill.meta.name)).length).toBe(
      Math.min(SKILLS.length, DEFAULT_ATTACHED_SKILLS),
    );
    const [short] = registry.load(['git-ship'], { maxChars: 10 });
    expect(short?.truncated).toBe(true);
    expect(short?.body.endsWith('…')).toBe(true);
  });

  it('puts the steps in the system prompt, above the tool listing', () => {
    const loaded = scratchRegistry().load(['web-research']);
    const prompt = buildSystemPrompt({
      records: [],
      tools: true,
      thinking: false,
      skillBodies: loaded,
    });
    expect(prompt).toContain('# Skills to follow');
    expect(prompt).toContain('## web-research');
    expect(prompt).toContain('Step one of web-research.');
    expect(prompt).toContain('Follow these steps for this reply.');
    // Above the tool schemas: a 0.6B model loses anything after a few kB of them.
    expect(prompt.indexOf('# Skills to follow')).toBeLessThan(prompt.indexOf('{"type":"function"'));
    // The listing stays: /name pins one skill, it does not blind the model to the rest.
    expect(prompt).toContain('# Skills');
  });

  it('says nothing about pinned skills for a turn that has none', () => {
    const prompt = buildSystemPrompt({ records: [], tools: true, thinking: false });
    expect(prompt).not.toContain('# Skills to follow');
  });
});

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  asSkillInput,
  parseFrontMatter,
  renderSkill,
  SkillError,
  SkillRegistry,
} from '../src/skills/registry.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'infagent-skills-'));
}

const SAMPLE = `---
name: web-research
description: Research a topic on the web.
when: The user needs current facts.
updatedAt: 2026-01-01T00:00:00.000Z
---

# Steps

1. Call webSearch.
`;

describe('skill files', () => {
  it('parses front matter and keeps the body', () => {
    const { fields, body } = parseFrontMatter(SAMPLE);
    expect(fields['name']).toBe('web-research');
    expect(fields['when']).toBe('The user needs current facts.');
    expect(body).toContain('1. Call webSearch.');
    expect(body).not.toContain('---');
  });

  it('treats a file without front matter as all body', () => {
    const { fields, body } = parseFrontMatter('# Just markdown');
    expect(fields).toEqual({});
    expect(body).toBe('# Just markdown');
  });

  it('renders a round-trippable file', () => {
    const source = renderSkill({
      name: 'demo',
      description: 'Demo skill.',
      when: 'Never.',
      body: 'Do the thing.',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { fields, body } = parseFrontMatter(source);
    expect(fields['name']).toBe('demo');
    expect(body).toBe('Do the thing.');
  });
});

describe('SkillRegistry', () => {
  it('lists only markdown skills, not the readme', () => {
    const root = scratch();
    writeFileSync(join(root, 'web-research.md'), SAMPLE);
    writeFileSync(join(root, 'README.md'), 'docs');
    writeFileSync(join(root, 'notes.txt'), 'ignore me');

    const skills = new SkillRegistry({ root });
    const list = skills.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.meta.name).toBe('web-research');
    expect(list[0]?.meta.description).toBe('Research a topic on the web.');
    expect(list[0]?.relativePath).toBe('skills/web-research.md');
  });

  it('creates, updates, searches and removes', () => {
    const root = scratch();
    const skills = new SkillRegistry({ root });

    const created = skills.create({
      name: 'release-notes',
      description: 'Write release notes from commits.',
      when: 'A release is tagged.',
      body: '1. Read the log.\n2. Group by type.',
    });
    expect(created.meta.name).toBe('release-notes');
    expect(existsSync(created.file)).toBe(true);
    expect(readFileSync(created.file, 'utf8')).toContain('name: release-notes');

    expect(skills.search('release')).toHaveLength(1);
    expect(skills.search('nothing-here')).toHaveLength(0);

    const updated = skills.update('release-notes', { body: '1. Only this step.' });
    expect(updated.body).toBe('1. Only this step.');
    expect(updated.meta.description).toBe('Write release notes from commits.');

    skills.remove('release-notes');
    expect(skills.list()).toHaveLength(0);
  });

  it('refuses duplicates and bad names', () => {
    const root = scratch();
    const skills = new SkillRegistry({ root });
    skills.create({ name: 'once', description: 'First.' });

    expect(() => skills.create({ name: 'once', description: 'Again.' })).toThrow(SkillError);
    expect(() => skills.create({ name: 'Bad Name', description: 'x' })).toThrow(
      /Invalid skill name/,
    );
    expect(() => skills.read('missing')).toThrow(/No skill named/);
  });

  it('describes itself for the prompt', () => {
    const root = scratch();
    const skills = new SkillRegistry({ root });
    expect(skills.listing()).toBe('No skills are defined yet.');

    skills.create({ name: 'a-skill', description: 'Does A.', when: 'A is needed.' });
    const listing = skills.listing();
    expect(listing).toContain('- a-skill: Does A. (use when: A is needed.)');
  });

  it('validates input coming from HTTP', () => {
    expect(() => asSkillInput({ description: 'no name' })).toThrow(/needs a `name`/);
    expect(asSkillInput({ name: ' ok ', description: 'd', when: 'w', body: 'b' })).toEqual({
      name: 'ok',
      description: 'd',
      when: 'w',
      body: 'b',
    });
  });
});

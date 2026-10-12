/**
 * Skills: reusable procedures the agent can load on demand.
 *
 * A skill is one markdown file in `skills/` with a small front-matter header:
 *
 *   ---
 *   name: web-research
 *   description: Research a topic on the web and cite the sources.
 *   when: The user asks for current facts, prices, news or sources.
 *   ---
 *
 *   # Steps
 *   1. call webSearch …
 *
 * Only the name, description and "when" line are shown to the model up front
 * (they are cheap). The body is fetched with `readSkill` when the skill is
 * actually used, which keeps the prompt small on a 0.6B model.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCRIPT_NAME_PATTERN } from '../scripts/registry.js';

/** Codes a skill operation can fail with (mirrors `ScriptError`'s vocabulary). */
export type SkillErrorCode = 'invalid' | 'invalid_name' | 'not_found' | 'conflict' | 'io';

export const SKILL_VERSION = 'infagent-skill/v1';

/**
 * How much of a pinned skill reaches the prompt. The whole catalogue is under
 * 1 kB per file, so these are head-room rather than everyday limits — they
 * exist so a long skill someone adds later cannot crowd out the reply.
 */
export const DEFAULT_ATTACHED_SKILLS = 4;
export const DEFAULT_SKILL_BODY_CHARS = 2000;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Where skills live by default: `skills/` next to the project. */
export const DEFAULT_SKILLS_DIR = join(ROOT, 'skills');

export interface SkillMeta {
  version: string;
  name: string;
  description: string;
  when: string;
  updatedAt: string;
}

export interface SkillRecord {
  meta: SkillMeta;
  file: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string;
}

export interface SkillDetail extends SkillRecord {
  /** The markdown body, front matter removed. */
  body: string;
  /** The file exactly as stored. */
  source: string;
}

export class SkillError extends Error {
  public readonly code: SkillErrorCode;

  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = 'SkillError';
    this.code = code;
  }
}

export interface SkillRegistryOptions {
  /** Folder holding the skills. Defaults to `INFAGENT_SKILLS_DIR` then `skills/`. */
  root?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the `---` delimited header into key/value pairs. */
export function parseFrontMatter(source: string): {
  fields: Record<string, string>;
  body: string;
} {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return { fields: {}, body: normalized.trim() };

  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { fields: {}, body: normalized.trim() };

  const header = normalized.slice(3, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const fields: Record<string, string> = {};

  for (const line of header.split('\n')) {
    const match = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match?.[1]) fields[match[1].toLowerCase()] = (match[2] ?? '').trim();
  }

  return { fields, body: body.trim() };
}

/** Build a complete skill file from its parts. */
export function renderSkill(input: {
  name: string;
  description: string;
  when?: string;
  body: string;
  updatedAt: string;
}): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    `when: ${input.when ?? ''}`,
    `updatedAt: ${input.updatedAt}`,
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
}

export class SkillRegistry {
  public readonly root: string;

  constructor(options: SkillRegistryOptions = {}) {
    this.root = resolve(options.root ?? process.env['INFAGENT_SKILLS_DIR'] ?? DEFAULT_SKILLS_DIR);
  }

  public ensureRoot(): string {
    if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  private fileFor(name: string): string {
    if (!SCRIPT_NAME_PATTERN.test(name)) {
      throw new SkillError('invalid', `Invalid skill name "${name}".`);
    }
    return join(this.root, `${name}.md`);
  }

  private static meta(name: string, fields: Record<string, string>, modifiedAt: string): SkillMeta {
    return {
      version: SKILL_VERSION,
      name,
      description: fields['description'] ?? '',
      when: fields['when'] ?? '',
      updatedAt: fields['updatedat'] ?? modifiedAt,
    };
  }

  public list(): SkillRecord[] {
    this.ensureRoot();

    return readdirSync(this.root)
      .filter((entry) => entry.endsWith('.md') && entry.toLowerCase() !== 'readme.md')
      .map((entry) => {
        const file = join(this.root, entry);
        const source = readFileSync(file, 'utf8');
        const stat = statSync(file);
        const name = entry.replace(/\.md$/, '');
        const { fields } = parseFrontMatter(source);

        return {
          meta: SkillRegistry.meta(name, fields, stat.mtime.toISOString()),
          file,
          relativePath: `skills/${entry}`,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((left, right) => left.meta.name.localeCompare(right.meta.name));
  }

  public read(name: string): SkillDetail {
    const file = this.fileFor(name);
    if (!existsSync(file)) throw new SkillError('not_found', `No skill named "${name}".`);

    const source = readFileSync(file, 'utf8');
    const stat = statSync(file);
    const { fields, body } = parseFrontMatter(source);

    return {
      meta: SkillRegistry.meta(name, fields, stat.mtime.toISOString()),
      file,
      relativePath: `skills/${name}.md`,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      body,
      source,
    };
  }

  public search(query: string): SkillRecord[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.list();

    return this.list().filter((record) => {
      const detail = readFileSync(record.file, 'utf8').toLowerCase();
      return detail.includes(needle);
    });
  }

  public create(input: {
    name: string;
    description: string;
    when?: string;
    body?: string;
    overwrite?: boolean;
  }): SkillDetail {
    const file = this.fileFor(input.name);
    if (existsSync(file) && input.overwrite !== true) {
      throw new SkillError('conflict', `Skill "${input.name}" already exists.`);
    }

    const description = input.description.trim() || `How to ${input.name.replace(/-/g, ' ')}.`;
    const body =
      input.body?.trim() ||
      [
        `# ${input.name.replace(/-/g, ' ')}`,
        '',
        '1. Describe the first step.',
        '2. Describe the next step.',
      ].join('\n');

    this.ensureRoot();
    writeFileSync(
      file,
      renderSkill({
        name: input.name,
        description,
        when: input.when ?? '',
        body,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    return this.read(input.name);
  }

  public update(
    name: string,
    patch: { description?: string; when?: string; body?: string },
  ): SkillDetail {
    const current = this.read(name);
    const source = renderSkill({
      name,
      description: patch.description?.trim() || current.meta.description,
      when: patch.when ?? current.meta.when,
      body: patch.body?.trim() || current.body,
      updatedAt: new Date().toISOString(),
    });

    writeFileSync(current.file, source, 'utf8');
    return this.read(name);
  }

  public remove(name: string): { name: string; file: string } {
    const file = this.fileFor(name);
    if (!existsSync(file)) throw new SkillError('not_found', `No skill named "${name}".`);
    unlinkSync(file);
    return { name, file };
  }

  /** One-line-per-skill listing used by the prompt and the CLI. */
  public listing(): string {
    const skills = this.list();
    if (skills.length === 0) return 'No skills are defined yet.';
    return skills
      .map(
        (skill) =>
          `- ${skill.meta.name}: ${skill.meta.description}${skill.meta.when ? ` (use when: ${skill.meta.when})` : ''}`,
      )
      .join('\n');
  }

  /**
   * The bodies of the named skills, for a turn that pinned them.
   *
   * A missing or unreadable skill is skipped rather than raised: the name came
   * from a message box, and a skill deleted since it was typed must not turn
   * into a failed reply. Bodies are cut to `maxChars` each and the list to
   * `limit` entries, because the body lands in a system prompt that has to
   * share the window with the answer.
   */
  public load(
    names: readonly string[],
    options: { limit?: number; maxChars?: number } = {},
  ): { name: string; body: string; truncated: boolean }[] {
    const limit = options.limit ?? DEFAULT_ATTACHED_SKILLS;
    const maxChars = options.maxChars ?? DEFAULT_SKILL_BODY_CHARS;
    const loaded: { name: string; body: string; truncated: boolean }[] = [];
    const seen = new Set<string>();

    for (const requested of names) {
      if (loaded.length >= limit) break;
      if (!SCRIPT_NAME_PATTERN.test(requested) || seen.has(requested)) continue;
      seen.add(requested);
      try {
        const detail = this.read(requested);
        const body = detail.body.length > maxChars;
        loaded.push({
          name: detail.meta.name,
          body: body ? `${detail.body.slice(0, maxChars).trimEnd()}…` : detail.body,
          truncated: body,
        });
      } catch {
        // No such skill (or unreadable): the other mentions still load.
      }
    }

    return loaded;
  }

  /** Compact shape sent to the UI. */
  public summary(): { count: number; root: string; skills: SkillRecord[] } {
    const skills = this.list();
    return { count: skills.length, root: this.root, skills };
  }
}

/** Guard used by the HTTP layer to keep request bodies sane. */
export function asSkillInput(body: unknown): {
  name: string;
  description: string;
  when?: string;
  body?: string;
} {
  if (!isRecord(body)) throw new SkillError('invalid', 'Body must be a JSON object.');
  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  const description = typeof body['description'] === 'string' ? body['description'] : '';
  const when = typeof body['when'] === 'string' ? body['when'] : undefined;
  const text = typeof body['body'] === 'string' ? body['body'] : undefined;

  if (!name) throw new SkillError('invalid', 'A skill needs a `name`.');
  return {
    name,
    description,
    ...(when === undefined ? {} : { when }),
    ...(text === undefined ? {} : { body: text }),
  };
}

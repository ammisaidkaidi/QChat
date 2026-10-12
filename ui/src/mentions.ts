/**
 * `/skill` mentions in the message box.
 *
 * Typing `/` opens the skill list; what follows it filters it. The mention stays
 * in the text, so the message itself says which skill it means — and a second
 * pass over the text is what decides which skills a message attaches, which
 * keeps the box and the request from ever disagreeing.
 *
 * All of it is pure text handling: no DOM, no Vue, so the same rules can be
 * tested and reused.
 */

/** A `/word` under the caret: where it starts, where its word ends, what was typed. */
export interface Mention {
  /** Index of the `/`. */
  start: number;
  /** Index just past the last character of the word (not the caret). */
  end: number;
  /** What was typed between the `/` and the caret; `''` right after the slash. */
  query: string;
}

/** Whitespace is what ends a word — a mention cannot contain one. */
const WORD_BREAK = /\s/;
/** Trailing punctuation is not part of a name: `/sqlite-inspection,` means the skill. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * The mention being typed, if there is one.
 *
 * A `/` only counts at the start of the text or after whitespace, so a fraction
 * (`1/2`) or a path someone pastes is left alone. The word after it must also be
 * whitespace-free up to the caret, or the slash belongs to an earlier word.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const slash = before.lastIndexOf('/');
  if (slash === -1) return null;

  // The word being typed: everything between the slash and the caret.
  const typed = before.slice(slash + 1);
  if (WORD_BREAK.test(typed)) return null;
  if (slash > 0 && !WORD_BREAK.test(text[slash - 1] ?? '')) return null;

  // The word may continue past the caret; Esc has to remove all of it.
  let end = slash + 1;
  while (end < text.length && !WORD_BREAK.test(text[end] ?? '')) end += 1;

  return { start: slash, end, query: typed };
}

/** One row of the completion list. */
export interface SkillOption {
  name: string;
  description: string;
  when?: string;
}

/** Name and description, the two things the list shows. */
export interface SkillLike {
  meta: { name: string; description: string; when?: string };
}

/**
 * The skills matching what was typed after the `/`.
 *
 * Case-insensitive substring on the name, with names that *start* with the
 * query first — typing `web` should offer `web-research` before a skill that
 * merely mentions it. An empty query lists everything, which is what a bare `/`
 * is for.
 */
export function filterSkills(
  skills: readonly SkillLike[],
  query: string,
  limit = 20,
): SkillOption[] {
  const needle = query.trim().toLowerCase();
  return skills
    .map((skill) => ({
      skill,
      name: skill.meta.name,
      lower: skill.meta.name.toLowerCase(),
    }))
    .filter((entry) => needle.length === 0 || entry.lower.includes(needle))
    .sort((a, b) => {
      const rank = (entry: { lower: string }) =>
        needle.length === 0 ? 0 : entry.lower.startsWith(needle) ? 0 : 1;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      // A shorter name that contains the query is usually the closer match.
      const byLength = a.name.length - b.name.length;
      return byLength !== 0 ? byLength : a.name.localeCompare(b.name);
    })
    .slice(0, limit)
    .map((entry) => ({
      name: entry.name,
      description: entry.skill.meta.description,
      ...(entry.skill.meta.when ? { when: entry.skill.meta.when } : {}),
    }));
}

/** What to do with the text and the caret after the list was used. */
export interface EditResult {
  text: string;
  caret: number;
}

/** Pick a skill: the typed word becomes the full name, and a space follows it. */
export function applyMention(text: string, mention: Mention, name: string): EditResult {
  const tail = text.slice(mention.end);
  // A space is added unless one is already there: at the end of the box (keep
  // typing) and inside a word. Never two.
  const insertion = tail.length > 0 && WORD_BREAK.test(tail[0] ?? '') ? `/${name}` : `/${name} `;
  const next = `${text.slice(0, mention.start)}${insertion}${tail}`;
  return { text: next, caret: mention.start + insertion.length };
}

/**
 * Esc: the `/` and the word go away, and one of the spaces that met in the
 * middle goes with them so the sentence does not end up with two.
 */
export function dropMention(text: string, mention: Mention): EditResult {
  const head = text.slice(0, mention.start);
  const tail = text.slice(mention.end);
  const joined =
    head.endsWith(' ') && tail.startsWith(' ') ? `${head}${tail.slice(1)}` : `${head}${tail}`;
  return { text: joined, caret: mention.start };
}

/**
 * The skills a message attaches, in the order they were written.
 *
 * Read from the text rather than tracked separately: a mention someone deleted
 * by hand is not attached, and one typed by hand is. Duplicates count once.
 */
export function attachedSkills(text: string, known: readonly string[]): string[] {
  const lookup = new Map(known.map((name) => [name.toLowerCase(), name]));
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)\/([^\s/]+)/g)) {
    const token = (match[1] ?? '').replace(TRAILING_PUNCTUATION, '');
    const name = lookup.get(token.toLowerCase());
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * System-prompt templates — the "way of thinking" the user picks for the agent.
 *
 * They live in `models/systemPrompts.json` as a plain array of
 * `{ name, description, prompt }` objects, so they can be edited in the console,
 * in an editor, or committed and shared. The selection itself (which template
 * is active) belongs to the user's preferences and is kept in
 * `models/models-settings.json` next to the active model.
 *
 * Templates are short on purpose: the default model is 0.6B, and a long style
 * block crowds out the tool declarations and the conversation.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { DEFAULT_SETTINGS_DIR, ModelStore } from './modelStore.js';

export const PROMPTS_VERSION = 'infagent-prompts/v1';

export interface SystemPromptTemplate {
  /** Short, unique, used as the identifier. */
  name: string;
  /** One line for the picker. */
  description: string;
  /** The instructions themselves. */
  prompt: string;
  /** Free-form labels, e.g. ["short", "daily"]. */
  tags?: string[];
  /** True for the templates that ship with the project. */
  builtin?: boolean;
  updatedAt?: string;
}

export class PromptError extends Error {
  public readonly code: 'bad_request' | 'io' | 'not_found';

  constructor(code: 'bad_request' | 'io' | 'not_found', message: string) {
    super(message);
    this.name = 'PromptError';
    this.code = code;
  }
}

/** The templates a fresh checkout starts with. */
export const DEFAULT_PROMPTS: SystemPromptTemplate[] = [
  {
    name: 'Precise',
    description: 'Answer in as few words as possible.',
    prompt:
      'Answer in one or two sentences. Give the result first, never restate the question, never add ' +
      'preamble or a summary. If the answer is a number, a name or a path, put it alone on the first line.',
    tags: ['short'],
    builtin: true,
  },
  {
    name: 'Step by step',
    description: 'Show the reasoning as numbered steps.',
    prompt:
      'Work through the request in numbered steps: one short line per step, then a final line starting ' +
      'with "Answer:". Keep each step to a few words. Never invent steps you did not take.',
    tags: ['reasoning'],
    builtin: true,
  },
  {
    name: 'Tool first',
    description: 'Call a tool before answering from memory.',
    prompt:
      'If a listed tool or script can answer the request, call it first and answer from its output. ' +
      'Never guess what a tool would return, and never describe a call you did not make. Only answer ' +
      'from memory when no tool fits, and say so.',
    tags: ['agentic'],
    builtin: true,
  },
  {
    name: 'Explain simply',
    description: 'Teach it to someone new to the topic.',
    prompt:
      'Assume the reader is new to the topic. Use short sentences and everyday words, explain any ' +
      'technical term the first time it appears, and finish with one concrete example.',
    tags: ['teaching'],
    builtin: true,
  },
  {
    name: 'Skeptical',
    description: 'Separate what is known from what is guessed.',
    prompt:
      'State plainly what you know, what you are unsure about, and what you cannot know. Never present ' +
      'a guess as a fact. If the request rests on a wrong assumption, say so before answering.',
    tags: ['careful'],
    builtin: true,
  },
  {
    name: 'Options',
    description: 'Give a few distinct alternatives.',
    prompt:
      'Offer two or three genuinely different options, one sentence each, and name the trade-off of ' +
      'each. Then say which one you would pick and why, in a single line.',
    tags: ['brainstorm'],
    builtin: true,
  },
];

export interface SystemPromptStoreOptions {
  /** Where `systemPrompts.json` lives. Defaults to the models folder. */
  file?: string;
  /** Where the active selection is stored. Defaults to the shared catalogue. */
  catalogue?: ModelStore;
}

export class SystemPromptStore {
  public readonly file: string;
  private readonly catalogue: ModelStore;

  constructor(options: SystemPromptStoreOptions = {}) {
    this.file =
      options.file ??
      process.env['INFAGENT_PROMPTS_FILE'] ??
      join(DEFAULT_SETTINGS_DIR, 'systemPrompts.json');
    this.catalogue = options.catalogue ?? new ModelStore();
  }

  /** Every template, seeding the file the first time it is missing. */
  public list(): SystemPromptTemplate[] {
    if (!existsSync(this.file)) {
      this.write(DEFAULT_PROMPTS);
      return [...DEFAULT_PROMPTS];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new PromptError('io', `${this.file} is not valid JSON: ${(error as Error).message}`);
    }

    const array = Array.isArray(parsed) ? parsed : [];
    return array
      .filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
      .map((entry) => this.normalise(entry))
      .filter((entry): entry is SystemPromptTemplate => entry !== null);
  }

  public get(name: string): SystemPromptTemplate | null {
    return this.list().find((entry) => entry.name === name) ?? null;
  }

  /** Create or update a template, identified by its name. */
  public save(input: {
    name?: unknown;
    description?: unknown;
    prompt?: unknown;
    tags?: unknown;
  }): SystemPromptTemplate {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const description =
      typeof input.description === 'string' ? input.description.trim().slice(0, 160) : '';

    if (!name) throw new PromptError('bad_request', 'A template needs a name.');
    if (name.length < 2) throw new PromptError('bad_request', 'The name is too short.');
    if (!prompt) throw new PromptError('bad_request', `The template "${name}" needs a prompt.`);
    if (prompt.length > 4000) {
      throw new PromptError(
        'bad_request',
        'Keep a template under 4000 characters — long styles crowd out the conversation.',
      );
    }

    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : undefined;

    const templates = this.list();
    const entry: SystemPromptTemplate = {
      name,
      description:
        description ||
        `${
          prompt
            .split(/[.!?\n]/)[0]
            ?.trim()
            .slice(0, 100) ?? name
        }.`,
      prompt,
      ...(tags && tags.length > 0 ? { tags } : {}),
      updatedAt: new Date().toISOString(),
    };

    const index = templates.findIndex((item) => item.name === name);
    if (index === -1) templates.push(entry);
    else templates[index] = { ...templates[index], ...entry };

    this.write(templates);
    return entry;
  }

  /** Remove a template; the active selection falls back to "none". */
  public remove(name: string): { removed: string; active: string } {
    const templates = this.list();
    const kept = templates.filter((entry) => entry.name !== name);
    if (kept.length === templates.length) {
      throw new PromptError('not_found', `No template named "${name}".`);
    }
    this.write(kept);
    if (this.activeName() === name) this.setActive('');
    return { removed: name, active: this.activeName() };
  }

  /** Name of the selected template, or '' when the agent uses the plain prompt. */
  public activeName(): string {
    return this.catalogue.activePrompt();
  }

  public setActive(name: string): string {
    const wanted = name.trim();
    if (wanted && !this.get(wanted)) {
      throw new PromptError('not_found', `No template named "${wanted}".`);
    }
    return this.catalogue.setActivePrompt(wanted);
  }

  /** The instructions of the selected template, or '' when none is selected. */
  public activePrompt(): string {
    const name = this.activeName();
    if (!name) return '';
    try {
      return this.get(name)?.prompt ?? '';
    } catch {
      // A broken file must never stop a chat turn.
      return '';
    }
  }

  private normalise(entry: Record<string, unknown>): SystemPromptTemplate | null {
    const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
    const prompt = typeof entry['prompt'] === 'string' ? entry['prompt'] : '';
    if (!name || !prompt.trim()) return null;
    const description = typeof entry['description'] === 'string' ? entry['description'] : '';
    const tags = Array.isArray(entry['tags'])
      ? entry['tags'].filter((tag): tag is string => typeof tag === 'string')
      : undefined;
    const builtin = entry['builtin'] === true ? true : undefined;
    const updatedAt = typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : undefined;
    return {
      name,
      description,
      prompt,
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(builtin ? { builtin } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  private write(templates: SystemPromptTemplate[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(templates, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw new PromptError('io', `Could not write ${this.file}: ${(error as Error).message}`);
    }
  }
}

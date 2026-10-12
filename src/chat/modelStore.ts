/**
 * Model catalogue.
 *
 * A model is described by a settings file and backed by a pile of weights, and
 * the two are deliberately kept apart:
 *
 *   models/Qwen3-0.6B-Q4_K_M.settings.json           ← how to run it (committed)
 *   models/models-settings.json                      ← which model is active
 *   ~/.cache/infagent/models/Qwen3-0.6B-Q4_K_M.gguf  ← the weights (~380 MB)
 *
 * The repository therefore stays complete *and* small: everything needed to
 * configure a model is versioned, while the bytes that a single download
 * reproduces live in a cache folder outside it. Dropping a GGUF into either
 * folder is enough to add a model — the next scan writes its settings file.
 *
 * All three locations are configurable: `INFAGENT_SETTINGS_DIR` (catalogue),
 * `INFAGENT_WEIGHTS_DIR` / `INFAGENT_MODELS_DIR` (weights) and
 * `INFAGENT_MODEL_PATH` (a single explicit file, which wins over the catalogue).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MODEL_SETTINGS_VERSION = 'infagent-model/v1';
export const CATALOGUE_VERSION = 'infagent-models/v1';

/** Repository root, no matter whether we run from `src/` or `dist/`. */
export const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Settings files live in the project's own `models/` folder (committed). */
export const DEFAULT_SETTINGS_DIR = join(PROJECT_ROOT, 'models');

/** Weights live in a cache outside the repository: large and reproducible. */
export const DEFAULT_WEIGHTS_DIR = join(homedir(), '.cache', 'infagent', 'models');

/** The catalogue folder — kept under its old name for the public API. */
export const DEFAULT_MODELS_DIR = DEFAULT_SETTINGS_DIR;

/**
 * How a model is prompted and how it answers tool calls.
 *
 *   `qwen3` (default) — Qwen3 convention: an optional `/no_think` switch and
 *     calls inside `<tool_call>{…}</tool_call>`.
 *   `xlam` — the Hammer2.1 / xLAM convention: no thinking switch, and the reply
 *     is a bare JSON array of calls, `[{"name": …, "arguments": {…}}]`.
 *   `plain` — everything else (Gemma, Llama, SmolLM2, LFM2.5, MiniCPM, …): no
 *     thinking switch either, and the common ChatML/Hermes convention — a
 *     `<tools>` listing plus `<tool_call>{"name": …}</tool_call>`.
 */
export type ModelStyle = 'qwen3' | 'xlam' | 'plain';

export interface ModelSettings {
  version: string;
  /** Stable identifier; also the settings file name. */
  id: string;
  /** Human label shown in the interface. */
  name: string;
  /** GGUF file name, resolved inside the settings or the weights folder. */
  file: string;
  family?: string;
  quantization?: string;
  description?: string;
  /** Where to fetch the weights when the file is missing. */
  source?: { url?: string; repo?: string };
  sizeBytes?: number;
  /** Runtime defaults — all overridable per request from the interface. */
  contextSize?: number;
  threads?: number;
  temperature?: number;
  maxTokens?: number;
  thinking?: boolean;
  /** Chat wrapper `node-llama-cpp` should use (`chatml` | `qwen` | `auto`). */
  chatWrapper?: 'chatml' | 'qwen' | 'auto';
  /** Prompting / tool-call convention. Defaults to `qwen3`. */
  style?: ModelStyle;
  /** Extra system-prompt text prepended for this model. */
  agentPrompt?: string;
}

export interface ModelRecord {
  settings: ModelSettings;
  /** Absolute path of the weights, whether present or not. */
  path: string;
  /** Absolute path of the settings file. */
  settingsPath: string;
  /** Folder the weights live in (or would live in). */
  weightsDir: string;
  present: boolean;
  sizeBytes: number;
  bytesOnDisk: number;
  active: boolean;
}

export interface ModelCatalogue {
  version: string;
  /** Identifier of the active model. */
  active: string;
  /** Offering order; unknown ids are appended at the end. */
  order: string[];
}

export interface ModelStoreOptions {
  /** Where the settings files live. Defaults to `<root>/models`. */
  dir?: string;
  /** Where the weights live. Defaults to `INFAGENT_WEIGHTS_DIR`, then the cache. */
  weightsDir?: string;
  /** Explicit GGUF path that overrides the catalogue entirely. */
  overridePath?: string;
}

const DEFAULTS = {
  contextSize: 2048,
  threads: 2,
  temperature: 0.4,
  maxTokens: 512,
  thinking: false,
  chatWrapper: 'chatml' as const,
  style: 'qwen3' as const,
};

/** `Qwen3-0.6B-Q4_K_M.gguf` → `Qwen3-0.6B-Q4_K_M` (underscores carry meaning). */
function modelStem(file: string): string {
  return basename(file).replace(/\.gguf$/i, '');
}

/** A file-system safe identifier: `Qwen3 0.6B Q4 KM` → `Qwen3-0.6B-Q4-KM`. */
function slugify(value: string): string {
  return value
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export class ModelStore {
  /** Folder holding the settings files (committed). */
  public readonly dir: string;
  /** Folder holding the `.gguf` weights (outside the repository). */
  public readonly weightsDir: string;
  public readonly overridePath: string | null;

  constructor(options: ModelStoreOptions = {}) {
    this.dir = resolve(
      options.dir ??
        process.env['INFAGENT_SETTINGS_DIR'] ??
        process.env['INFAGENT_MODELS_DIR'] ??
        DEFAULT_SETTINGS_DIR,
    );
    this.weightsDir = resolve(
      options.weightsDir ?? process.env['INFAGENT_WEIGHTS_DIR'] ?? DEFAULT_WEIGHTS_DIR,
    );
    this.overridePath = options.overridePath
      ? resolve(options.overridePath)
      : (process.env['INFAGENT_MODEL_PATH'] ?? null);
  }

  /** Create both folders if needed; safe to call often. */
  public ensureDir(): string {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.weightsDir)) mkdirSync(this.weightsDir, { recursive: true });
    return this.dir;
  }

  private settingsPathFor(id: string): string {
    return join(this.dir, `${id}.settings.json`);
  }

  public catalogue(): ModelCatalogue {
    const path = join(this.dir, 'models-settings.json');
    const stored = readJson<Partial<ModelCatalogue>>(path) ?? {};
    return {
      version: stored.version ?? CATALOGUE_VERSION,
      active: stored.active ?? '',
      order: Array.isArray(stored.order) ? stored.order : [],
    };
  }

  private saveCatalogue(catalogue: ModelCatalogue): void {
    this.ensureDir();
    writeJson(join(this.dir, 'models-settings.json'), catalogue);
  }

  /**
   * Every model in the catalogue, with the active one flagged.
   *
   * GGUFs without a settings file get one written on the spot, so a file copied
   * into either folder by hand is usable immediately.
   */
  public list(): ModelRecord[] {
    this.ensureDir();

    const gguf = (folder: string): string[] =>
      existsSync(folder)
        ? readdirSync(folder).filter((entry) => entry.toLowerCase().endsWith('.gguf'))
        : [];
    const files = [...new Set([...gguf(this.dir), ...gguf(this.weightsDir)])];
    const settingsFiles = readdirSync(this.dir).filter((entry) => entry.endsWith('.settings.json'));

    const ids = settingsFiles.map((entry) => entry.replace(/\.settings\.json$/, ''));
    const knownFiles = new Set<string>();

    for (const id of ids) {
      const settings = readJson<ModelSettings>(this.settingsPathFor(id));
      if (settings?.file) knownFiles.add(settings.file);
    }

    // Adopt anything that looks like a model but has no settings yet.
    for (const file of files) {
      if (knownFiles.has(file)) continue;
      const id = slugify(modelStem(file)) || file;
      if (ids.includes(id)) continue;
      this.writeSettings(this.defaultSettings(id, file));
      ids.push(id);
    }

    const catalogue = this.catalogue();
    const records = ids
      .map((id) => this.record(id))
      .filter((record): record is ModelRecord => record !== null);

    const rank = (id: string): number => {
      const index = catalogue.order.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    records.sort((left, right) => rank(left.settings.id) - rank(right.settings.id));

    const activeId = this.activeId(records, catalogue);
    return records.map((record) => ({ ...record, active: record.settings.id === activeId }));
  }

  /** Effective active id given what is on disk and what the catalogue says. */
  private activeId(records: readonly ModelRecord[], catalogue: ModelCatalogue): string {
    if (this.overridePath) return '';
    const requested = catalogue.active;
    // The choice wins, even before its weights are downloaded: selecting a model
    // is how the user asks for it, and the console then says "not downloaded"
    // and offers the download — silently keeping the previous model was worse.
    if (requested && records.some((record) => record.settings.id === requested)) return requested;
    // A catalogue entry whose settings file is gone falls back to something
    // runnable rather than leaving the console pointing at nothing.
    const present = records.find((record) => record.present);
    return present?.settings.id ?? records[0]?.settings.id ?? '';
  }

  /** Where a weights file lives: beside the settings, else in the cache. */
  public weightsPath(file: string): string {
    const beside = join(this.dir, file);
    if (existsSync(beside)) return beside;
    return join(this.weightsDir, file);
  }

  private record(id: string): ModelRecord | null {
    const settings = readJson<ModelSettings>(this.settingsPathFor(id));
    if (!settings) return null;

    const file = settings.file || `${id}.gguf`;
    const path = this.weightsPath(file);
    const present = existsSync(path);
    const bytesOnDisk = present ? statSync(path).size : 0;

    return {
      settings: { ...settings, id: settings.id || id, file },
      path,
      settingsPath: this.settingsPathFor(id),
      weightsDir: path.replace(/[/\\][^/\\]*$/, ''),
      present,
      sizeBytes: settings.sizeBytes ?? bytesOnDisk,
      bytesOnDisk,
      active: false,
    };
  }

  public get(id: string): ModelRecord | null {
    return this.list().find((record) => record.settings.id === id) ?? null;
  }

  /** The model the engine should load. */
  public active(): ModelRecord | null {
    const records = this.list();
    if (this.overridePath) {
      const override = records.find((record) => record.path === this.overridePath);
      if (override) return { ...override, active: true };
      const present = existsSync(this.overridePath);
      const size = present ? statSync(this.overridePath).size : 0;
      return {
        settings: this.defaultSettings(
          slugify(modelStem(this.overridePath)),
          basename(this.overridePath),
          { source: { url: process.env['INFAGENT_MODEL_URL'] ?? '' } },
        ),
        path: this.overridePath,
        settingsPath: `${this.overridePath}.settings.json`,
        weightsDir: this.overridePath.replace(/[/\\][^/\\]*$/, ''),
        present,
        sizeBytes: size,
        bytesOnDisk: size,
        active: true,
      };
    }
    return records.find((record) => record.active) ?? null;
  }

  /** Runtime settings the engine should use, with env overrides applied. */
  public activeContext(): {
    id: string;
    path: string;
    dir: string;
    weightsDir: string;
    contextSize: number;
    threads: number;
    temperature: number;
    maxTokens: number;
    thinking: boolean;
    chatWrapper: NonNullable<ModelSettings['chatWrapper']>;
    style: ModelStyle;
    agentPrompt: string;
  } {
    const record = this.active();
    const settings = record?.settings;
    return {
      id: settings?.id ?? '',
      path: record?.path ?? join(this.weightsDir, 'model.gguf'),
      dir: this.dir,
      weightsDir: record?.weightsDir ?? this.weightsDir,
      contextSize: this.number(
        settings?.contextSize,
        process.env['INFAGENT_LLM_CONTEXT'],
        DEFAULTS.contextSize,
      ),
      threads: this.number(
        settings?.threads,
        process.env['INFAGENT_LLM_THREADS'],
        DEFAULTS.threads,
      ),
      temperature: this.number(settings?.temperature, undefined, DEFAULTS.temperature),
      maxTokens: this.number(settings?.maxTokens, undefined, DEFAULTS.maxTokens),
      thinking: settings?.thinking ?? DEFAULTS.thinking,
      chatWrapper: settings?.chatWrapper ?? DEFAULTS.chatWrapper,
      style: settings?.style ?? DEFAULTS.style,
      agentPrompt: settings?.agentPrompt?.trim() ?? '',
    };
  }

  private number(
    fromSettings: number | undefined,
    fromEnv: string | undefined,
    fallback: number,
  ): number {
    const env = fromEnv === undefined ? undefined : Number(fromEnv);
    if (env !== undefined && Number.isFinite(env)) return env;
    if (fromSettings !== undefined && Number.isFinite(fromSettings)) return fromSettings;
    return fallback;
  }

  /** Point the catalogue at another model. Returns the new effective model. */
  public setActive(id: string): ModelRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown model "${id}".`);

    const catalogue = this.catalogue();
    const order = [id, ...catalogue.order.filter((entry) => entry !== id)];
    this.saveCatalogue({ ...catalogue, version: CATALOGUE_VERSION, active: id, order });
    return { ...record, active: true };
  }

  /** Sensible settings for a GGUF we know nothing about yet. */
  public defaultSettings(
    id: string,
    file: string,
    extra: Partial<ModelSettings> = {},
  ): ModelSettings {
    const name = modelStem(file);
    const quantization = /q[0-9]_[a-z0-9]+/i.exec(name)?.[0]?.toUpperCase();
    return {
      version: MODEL_SETTINGS_VERSION,
      id,
      name,
      file,
      family: name.split(/[-_. ]/)[0]?.toLowerCase() || 'unknown',
      ...(quantization ? { quantization } : {}),
      description: `${name} as a local GGUF model.`,
      ...DEFAULTS,
      ...extra,
    };
  }

  /** Write (or refresh) a model's settings file. */
  public writeSettings(settings: ModelSettings): string {
    this.ensureDir();
    const path = this.settingsPathFor(settings.id);
    writeJson(path, { ...settings, version: MODEL_SETTINGS_VERSION });
    return path;
  }

  /**
   * Register a model after a download: keeps the settings file in sync with the
   * file that actually landed on disk.
   */
  public register(settings: ModelSettings, options: { makeActive?: boolean } = {}): ModelRecord {
    this.writeSettings(settings);
    if (options.makeActive !== false) this.setActive(settings.id);
    const record = this.get(settings.id);
    if (!record) throw new Error(`Could not register model "${settings.id}".`);
    return record;
  }
}

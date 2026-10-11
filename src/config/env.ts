/**
 * Environment loading & validation.
 *
 * Single source of truth: `.env`, generated from `env.txt` with
 * `npm run env:from-txt`. Nothing here ever logs a secret value in the clear —
 * use `redact()` / `snapshot()` when you need to surface config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config as loadDotenv, parse } from 'dotenv';

/** Keys whose values must never be printed unredacted. */
const SENSITIVE_KEY =
  /(SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE|DSN|CONNECTION[_-]?STRING|DATABASE_URL)/i;

let loaded = false;
let loadedFrom: string | undefined;
let loadedKeys: string[] = [];

export class EnvError extends Error {
  public readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.\n` +
        'Add them to .env (regenerate it with `npm run env:from-txt`) or export them in your shell.',
    );
    this.name = 'EnvError';
    this.missing = [...missing];
  }
}

export interface LoadEnvOptions {
  /** Path to the env file. Defaults to `<cwd>/.env`. */
  path?: string;
  /** Overwrite variables already present in `process.env`. Defaults to `false`. */
  override?: boolean;
  /** Suppress the "no env file" notice. */
  silent?: boolean;
}

export function defaultEnvFile(): string {
  return resolve(process.cwd(), '.env');
}

/**
 * Load `<cwd>/.env` into `process.env` (idempotent, safe to call from anywhere).
 * Existing shell variables always win unless `override` is set.
 *
 * @returns `true` when a file was found and parsed.
 */
export function loadEnv(options: LoadEnvOptions = {}): boolean {
  const envPath = options.path ?? defaultEnvFile();

  if (!existsSync(envPath)) {
    if (!options.silent) {
      console.warn(`[infagent] no env file at ${envPath} — using the process environment only`);
    }
    return false;
  }

  loadDotenv({ path: envPath, override: options.override ?? false, quiet: true });
  loaded = true;
  loadedFrom = envPath;
  loadedKeys = Object.keys(parse(readFileSync(envPath, 'utf8')));
  return true;
}

/** Ensure the env file has been loaded exactly once. */
export function ensureEnv(options: LoadEnvOptions = {}): boolean {
  return loaded ? true : loadEnv({ silent: true, ...options });
}

export function isEnvLoaded(): boolean {
  return loaded;
}

export function envSource(): string | undefined {
  return loadedFrom;
}

/** Keys declared in the loaded env file (not the whole system environment). */
export function envKeys(): readonly string[] {
  return [...loadedKeys].sort();
}

/** Read a variable, falling back to `fallback` (or `undefined`). */
export function getEnv(key: string, fallback: string): string;
export function getEnv(key: string, fallback?: string): string | undefined;
export function getEnv(key: string, fallback?: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Read variables that must exist, or throw a single `EnvError` listing all of them.
 * Fails fast at startup instead of exploding on first use.
 */
export function requireEnv(...keys: string[]): Record<string, string> {
  const missing = keys.filter((key) => getEnv(key) === undefined);
  if (missing.length > 0) throw new EnvError(missing);

  const result: Record<string, string> = {};
  for (const key of keys) {
    result[key] = process.env[key] as string;
  }
  return result;
}

export function getEnvInt(key: string, fallback?: number): number | undefined {
  const raw = getEnv(key);
  if (raw === undefined) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new EnvError([`${key} (expected an integer, got "${raw}")`]);
  }
  return parsed;
}

export function getEnvBool(key: string, fallback = false): boolean {
  const raw = getEnv(key);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** `true` when the key name looks like it holds a secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Mask a value for logs: `sk-a…4f2a` style, never the full secret. */
export function redact(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}${'*'.repeat(Math.min(6, value.length - 6))}${value.slice(-3)}`;
}

export interface EnvEntry {
  key: string;
  value: string;
  sensitive: boolean;
}

/**
 * Snapshot the environment, redacting anything that looks sensitive.
 * Handy for `--json` diagnostics and bug reports.
 */
export function snapshot(keys?: readonly string[]): EnvEntry[] {
  const source = keys ?? Object.keys(process.env).sort();
  return source
    .filter((key) => getEnv(key) !== undefined)
    .map((key) => {
      const raw = getEnv(key) as string;
      const sensitive = isSensitiveKey(key);
      return { key, value: sensitive ? redact(raw) : raw, sensitive };
    });
}

/** Reset internal bookkeeping (used by tests). Does not touch `process.env`. */
export function resetEnvState(): void {
  loaded = false;
  loadedFrom = undefined;
  loadedKeys = [];
}

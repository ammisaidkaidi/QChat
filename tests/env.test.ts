import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EnvError,
  getEnv,
  getEnvBool,
  getEnvInt,
  isSensitiveKey,
  redact,
  requireEnv,
  resetEnvState,
  snapshot,
} from '../src/config/env.js';

const TOUCHED = ['INFAGENT_TEST_PLAIN', 'INFAGENT_TEST_API_KEY', 'INFAGENT_TEST_NUM'];

describe('env helpers', () => {
  beforeEach(() => {
    resetEnvState();
    for (const key of TOUCHED) delete process.env[key];
  });

  afterEach(() => {
    for (const key of TOUCHED) delete process.env[key];
  });

  it('reads variables with a fallback', () => {
    process.env['INFAGENT_TEST_PLAIN'] = 'hello';
    expect(getEnv('INFAGENT_TEST_PLAIN')).toBe('hello');
    expect(getEnv('INFAGENT_TEST_PLAIN', 'fallback')).toBe('hello');
    expect(getEnv('INFAGENT_TEST_MISSING', 'fallback')).toBe('fallback');
    expect(getEnv('INFAGENT_TEST_MISSING')).toBeUndefined();
  });

  it('treats empty strings as absent', () => {
    process.env['INFAGENT_TEST_PLAIN'] = '';
    expect(getEnv('INFAGENT_TEST_PLAIN', 'fallback')).toBe('fallback');
  });

  it('requireEnv returns present keys and reports every missing key at once', () => {
    process.env['INFAGENT_TEST_PLAIN'] = 'yes';
    expect(requireEnv('INFAGENT_TEST_PLAIN')).toEqual({ INFAGENT_TEST_PLAIN: 'yes' });

    try {
      requireEnv('INFAGENT_TEST_PLAIN', 'INFAGENT_TEST_NOPE', 'INFAGENT_TEST_ALSO_NOPE');
      expect.unreachable('requireEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const envError = error as EnvError;
      expect(envError.missing).toEqual(['INFAGENT_TEST_NOPE', 'INFAGENT_TEST_ALSO_NOPE']);
      expect(envError.message).toContain('INFAGENT_TEST_NOPE');
      expect(envError.message).toContain('INFAGENT_TEST_ALSO_NOPE');
    }
  });

  it('parses ints and rejects garbage', () => {
    process.env['INFAGENT_TEST_NUM'] = '42';
    expect(getEnvInt('INFAGENT_TEST_NUM', 1)).toBe(42);
    expect(getEnvInt('INFAGENT_TEST_MISSING', 7)).toBe(7);

    process.env['INFAGENT_TEST_NUM'] = 'not-a-number';
    expect(() => getEnvInt('INFAGENT_TEST_NUM')).toThrow(EnvError);
  });

  it('parses booleans', () => {
    expect(getEnvBool('INFAGENT_TEST_MISSING')).toBe(false);
    expect(getEnvBool('INFAGENT_TEST_MISSING', true)).toBe(true);

    process.env['INFAGENT_TEST_PLAIN'] = 'ON';
    expect(getEnvBool('INFAGENT_TEST_PLAIN')).toBe(true);
  });

  it('flags sensitive keys', () => {
    expect(isSensitiveKey('OPENAI_API_KEY')).toBe(true);
    expect(isSensitiveKey('GITHUB_TOKEN')).toBe(true);
    expect(isSensitiveKey('DB_PASSWORD')).toBe(true);
    expect(isSensitiveKey('SMTP_PASS')).toBe(true);
    expect(isSensitiveKey('DATABASE_URL')).toBe(true);
    expect(isSensitiveKey('VAPID_PRIVATE_KEY')).toBe(true);
    expect(isSensitiveKey('NVIDIA_API_KEY')).toBe(true);

    expect(isSensitiveKey('LOG_LEVEL')).toBe(false);
    expect(isSensitiveKey('SMTP_HOST')).toBe(false);
    expect(isSensitiveKey('SMTP_USER')).toBe(false);
    expect(isSensitiveKey('VAPID_PUBLIC_KEY')).toBe(false);
    expect(isSensitiveKey('PORT')).toBe(false);
  });

  it('redacts secrets without leaking them', () => {
    const secret = 'sk-live-abcdef1234567890';
    const masked = redact(secret);
    expect(masked).not.toContain('abcdef');
    expect(masked.startsWith('sk-')).toBe(true);
    expect(masked.endsWith('890')).toBe(true);
    expect(redact('short')).toBe('*****');
  });

  it('redacts sensitive values inside snapshots', () => {
    process.env['INFAGENT_TEST_API_KEY'] = 'super-secret-value';
    process.env['INFAGENT_TEST_PLAIN'] = 'visible';

    const entries = snapshot(['INFAGENT_TEST_API_KEY', 'INFAGENT_TEST_PLAIN']);
    const apiKey = entries.find((entry) => entry.key === 'INFAGENT_TEST_API_KEY');
    const plain = entries.find((entry) => entry.key === 'INFAGENT_TEST_PLAIN');

    expect(apiKey?.sensitive).toBe(true);
    expect(apiKey?.value).not.toContain('secret');
    expect(plain?.sensitive).toBe(false);
    expect(plain?.value).toBe('visible');
  });
});

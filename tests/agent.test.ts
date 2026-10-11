import { describe, expect, it } from 'vitest';

import { Agent } from '../src/lib/agent.js';
import { VERSION, buildInfo } from '../src/version.js';

describe('Agent', () => {
  it('uses the default name when nothing is configured', () => {
    const agent = new Agent();
    expect(agent.name).toBe('InfAgent');
  });

  it('accepts an explicit name', () => {
    expect(new Agent({ name: 'infra-bot' }).name).toBe('infra-bot');
  });

  it('runs tasks through the default stub handler', async () => {
    const result = await new Agent({ name: 'test' }).run('deploy');

    expect(result.ok).toBe(true);
    expect(result.agent).toBe('test');
    expect(result.output).toContain('deploy');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('supports a custom async handler', async () => {
    const agent = new Agent({ handler: async (task) => task.toUpperCase() });
    const result = await agent.run('ship it');
    expect(result.output).toBe('SHIP IT');
  });

  it('captures handler failures instead of throwing', async () => {
    const agent = new Agent({
      handler: () => {
        throw new Error('boom');
      },
    });

    const result = await agent.run('anything');
    expect(result.ok).toBe(false);
    expect(result.output).toBe('boom');
  });
});

describe('build info', () => {
  it('exposes a semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(buildInfo().version).toBe(VERSION);
    expect(buildInfo().node).toBe(process.version);
  });
});

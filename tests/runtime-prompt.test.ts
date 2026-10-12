import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCloudSystemMessage, CloudProviderStore } from '../src/cloud/providers.js';
import { DEFAULT_MODEL, QwenEngine } from '../src/chat/qwen.js';
import { McpManager } from '../src/mcp/manager.js';
import { ScriptRegistry } from '../src/scripts/registry.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { createServer } from '../src/server/server.js';

type Harness = {
  directory: string;
  url: string;
  server: Server;
  mcp: McpManager;
};

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) continue;
    await harness.mcp.stopAll();
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

async function startServer(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'infagent-runtime-prompt-'));
  const scriptsDir = join(directory, 'scripts');
  const skillsDir = join(directory, 'skills');
  const modelsDir = join(directory, 'models');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  const mcpConfig = join(directory, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ servers: {} }), 'utf8');

  const registry = new ScriptRegistry({ root: scriptsDir });
  const skills = new SkillRegistry({ root: skillsDir });
  const mcp = new McpManager({ configPath: mcpConfig });
  const engine = new QwenEngine({
    registry,
    skills,
    mcp,
    modelsDir,
    weightsDir: join(directory, 'weights'),
    idleUnloadMs: 1_000_000,
  });
  skills.create({
    name: 'repo-search',
    description: 'Search a repository.',
    body: 'Inspect the relevant files before answering.',
  });
  const server = createServer({
    registry,
    skills,
    mcp,
    engine,
    cloudProviders: new CloudProviderStore(join(directory, 'cloud-providers.json')),
    chatDbPath: join(directory, 'data', 'chats.sqlite'),
    uiDir: join(directory, 'ui'),
    envFile: join(directory, '.env'),
    envReference: join(directory, '.env.example'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port.');
  const harness = { directory, url: `http://127.0.0.1:${address.port}`, server, mcp };
  harnesses.push(harness);
  return harness;
}

async function postPreview(
  harness: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { systemPrompt?: string; error?: string } }> {
  const response = await fetch(`${harness.url}/api/chat/prompt-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { systemPrompt?: string; error?: string },
  };
}

describe('runtime system prompt preview', () => {
  it('assembles the selected model, style, tools, MCP and attached skills without loading weights', () => {
    const directory = mkdtempSync(join(tmpdir(), 'infagent-prompt-engine-'));
    try {
      const scriptsDir = join(directory, 'scripts');
      const skillsDir = join(directory, 'skills');
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });
      const registry = new ScriptRegistry({ root: scriptsDir });
      const skills = new SkillRegistry({ root: skillsDir });
      skills.create({
        name: 'safe-math',
        description: 'Check arithmetic.',
        body: 'Write down the calculation and verify the result.',
      });

      const mcp = {
        list: () => [{ name: 'notes', enabled: true, description: 'Search the project notes.' }],
        tools: () => [
          {
            server: 'notes',
            tool: {
              name: 'search',
              description: 'Find relevant notes.',
              inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Text to search for.' } },
                required: ['query'],
              },
            },
          },
        ],
      } as unknown as McpManager;
      const engine = new QwenEngine({
        registry,
        skills,
        mcp,
        modelsDir: join(directory, 'models'),
        weightsDir: join(directory, 'weights'),
      });
      const alternate = {
        ...DEFAULT_MODEL,
        id: 'prompt-preview-xlam',
        name: 'Prompt Preview xLAM',
        file: 'prompt-preview-xlam.gguf',
        style: 'xlam' as const,
        agentPrompt: 'MODEL-SPECIFIC: Check your work.',
      };
      engine.store.register(alternate, { makeActive: false });
      const activeBefore = engine.store.activeContext().id;

      const prompt = engine.previewSystemPrompt({
        modelSource: 'local',
        modelId: alternate.id,
        tools: true,
        net: true,
        thinking: false,
        maxToolIterations: 4,
        promptTemplate: 'Use short, direct answers.',
        skills: ['safe-math'],
        mcpServers: ['notes'],
      });

      expect(prompt).toContain('MODEL-SPECIFIC: Check your work.');
      expect(prompt).toContain('# Working style\nUse short, direct answers.');
      expect(prompt).toContain('## safe-math');
      expect(prompt).toContain('verify the result.');
      expect(prompt).toContain('[BEGIN OF AVAILABLE_TOOLS]');
      expect(prompt).toContain('notes__search');
      expect(prompt).toContain('MCP servers: notes — Search the project notes.');
      expect(prompt).toContain('at most 4 steps per reply.');
      expect(prompt).not.toContain('/no_think');
      expect(engine.store.activeContext().id).toBe(activeBefore);
      expect(engine.isLoaded()).toBe(false);

      expect(
        engine.previewSystemPrompt({
          modelId: alternate.id,
          systemPrompt: '  Use only this custom instruction.  ',
          promptTemplate: 'Ignored by the custom override.',
          skills: ['safe-math'],
          tools: true,
        }),
      ).toBe('Use only this custom instruction.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns the local engine prompt from the preview API without loading the model', async () => {
    const harness = await startServer();
    const result = await postPreview(harness, {
      modelSource: 'local',
      modelId: DEFAULT_MODEL.id,
      tools: false,
      net: false,
      systemPrompt: '',
      promptTemplate: 'The preview is live.',
      skills: ['repo-search'],
    });

    expect(result.status).toBe(200);
    expect(result.body.systemPrompt).toContain('# Working style\nThe preview is live.');
    expect(result.body.systemPrompt).toContain('## repo-search');
    expect(result.body.systemPrompt).toContain('Inspect the relevant files before answering.');
    expect(result.body.systemPrompt).not.toContain('<tools>');
  });

  it('previews the same cloud system message format used by provider requests', async () => {
    const harness = await startServer();
    const body = {
      modelSource: 'cloud',
      systemPrompt: 'Be helpful and concise.',
      promptTemplate: 'Answer in one sentence.',
      skills: ['repo-search'],
    };
    const result = await postPreview(harness, body);

    expect(result.status).toBe(200);
    expect(result.body.systemPrompt).toBe(
      buildCloudSystemMessage({
        systemPrompt:
          'Be helpful and concise.\n\n## Attached skill: repo-search\nInspect the relevant files before answering.',
        promptTemplate: 'Answer in one sentence.',
      }),
    );
  });

  it('rejects malformed preview configuration', async () => {
    const harness = await startServer();
    const result = await postPreview(harness, { modelSource: 'remote' });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('modelSource must be local or cloud.');
  });
});

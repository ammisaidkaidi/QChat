/**
 * Public library surface — `import { Agent, ScriptRegistry } from 'infagent'`.
 */
export {
  EnvError,
  ensureEnv,
  envKeys,
  envSource,
  getEnv,
  getEnvBool,
  getEnvInt,
  isEnvLoaded,
  isSensitiveKey,
  loadEnv,
  redact,
  requireEnv,
  resetEnvState,
  snapshot,
} from '../config/env.js';
export type { EnvEntry, LoadEnvOptions } from '../config/env.js';

export { Agent } from './agent.js';
export type { AgentOptions, AgentRunResult, TaskHandler } from './agent.js';

// Agent script toolbox: the built-in callbacks an LLM can invoke.
export {
  ScriptRegistry,
  ScriptError,
  defaultRegistry,
  createScript,
  describeScript,
  listScripts,
  readScript,
  removeScript,
  runScript,
  searchScripts,
  scriptAgentPrompt,
  scriptStats,
  scriptSystemPrompt,
  scriptTools,
  updateScript,
} from '../scripts/index.js';
export type {
  CreateScriptInput,
  ScriptDetail,
  ScriptLanguage,
  ScriptMeta,
  ScriptParam,
  ScriptRecord,
  ScriptRunResult,
  ScriptStats,
  ToolDefinition,
  UpdateScriptInput,
} from '../scripts/index.js';

export { createServer, startServer } from '../server/server.js';
export type { ServerOptions, RunningServer } from '../server/server.js';

export { VERSION, buildInfo } from '../version.js';
export type { BuildInfo } from '../version.js';

/**
 * Public library surface — `import { Agent, loadEnv } from 'infagent'`.
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

export { VERSION, buildInfo } from '../version.js';
export type { BuildInfo } from '../version.js';

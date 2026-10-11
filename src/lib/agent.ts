/**
 * Minimal agent core. The task handler is injectable so the transport
 * (LLM call, shell, HTTP, …) can be swapped without touching the runtime.
 */
import { ensureEnv, getEnv } from '../config/env.js';

export interface AgentRunResult {
  ok: boolean;
  output: string;
  durationMs: number;
  agent: string;
}

export type TaskHandler = (task: string, agent: Agent) => Promise<string> | string;

export interface AgentOptions {
  /** Display name. Defaults to `$INFAGENT_NAME`, then `InfAgent`. */
  name?: string;
  /** Override the task handler (default: echo handler). */
  handler?: TaskHandler;
}

const echoHandler: TaskHandler = (task) => `[stub] received task: ${task}`;

export class Agent {
  public readonly name: string;
  private readonly handler: TaskHandler;

  constructor(options: AgentOptions = {}) {
    ensureEnv();
    this.name = options.name ?? getEnv('INFAGENT_NAME', 'InfAgent');
    this.handler = options.handler ?? echoHandler;
  }

  /** Execute a task and time it. Never throws for handler failures. */
  public async run(task: string): Promise<AgentRunResult> {
    const startedAt = Date.now();
    try {
      const output = await this.handler(task, this);
      return { ok: true, output, durationMs: Date.now() - startedAt, agent: this.name };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: message, durationMs: Date.now() - startedAt, agent: this.name };
    }
  }
}

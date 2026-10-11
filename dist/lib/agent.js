/**
 * Minimal agent core. The task handler is injectable so the transport
 * (LLM call, shell, HTTP, …) can be swapped without touching the runtime.
 */
import { ensureEnv, getEnv } from '../config/env.js';
const echoHandler = (task) => `[stub] received task: ${task}`;
export class Agent {
    name;
    handler;
    constructor(options = {}) {
        ensureEnv();
        this.name = options.name ?? getEnv('INFAGENT_NAME', 'InfAgent');
        this.handler = options.handler ?? echoHandler;
    }
    /** Execute a task and time it. Never throws for handler failures. */
    async run(task) {
        const startedAt = Date.now();
        try {
            const output = await this.handler(task, this);
            return { ok: true, output, durationMs: Date.now() - startedAt, agent: this.name };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, output: message, durationMs: Date.now() - startedAt, agent: this.name };
        }
    }
}
//# sourceMappingURL=agent.js.map
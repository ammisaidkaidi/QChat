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
export declare class Agent {
    readonly name: string;
    private readonly handler;
    constructor(options?: AgentOptions);
    /** Execute a task and time it. Never throws for handler failures. */
    run(task: string): Promise<AgentRunResult>;
}
//# sourceMappingURL=agent.d.ts.map
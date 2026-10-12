import { ModelStore } from './modelStore.js';
export declare const PROMPTS_VERSION = "infagent-prompts/v1";
export interface SystemPromptTemplate {
    /** Short, unique, used as the identifier. */
    name: string;
    /** One line for the picker. */
    description: string;
    /** The instructions themselves. */
    prompt: string;
    /** Free-form labels, e.g. ["short", "daily"]. */
    tags?: string[];
    /** True for the templates that ship with the project. */
    builtin?: boolean;
    updatedAt?: string;
}
export declare class PromptError extends Error {
    readonly code: 'bad_request' | 'io' | 'not_found';
    constructor(code: 'bad_request' | 'io' | 'not_found', message: string);
}
/** The templates a fresh checkout starts with. */
export declare const DEFAULT_PROMPTS: SystemPromptTemplate[];
export interface SystemPromptStoreOptions {
    /** Where `systemPrompts.json` lives. Defaults to the models folder. */
    file?: string;
    /** Where the active selection is stored. Defaults to the shared catalogue. */
    catalogue?: ModelStore;
}
export declare class SystemPromptStore {
    readonly file: string;
    private readonly catalogue;
    constructor(options?: SystemPromptStoreOptions);
    /** Every template, seeding the file the first time it is missing. */
    list(): SystemPromptTemplate[];
    get(name: string): SystemPromptTemplate | null;
    /** Create or update a template, identified by its name. */
    save(input: {
        name?: unknown;
        description?: unknown;
        prompt?: unknown;
        tags?: unknown;
    }): SystemPromptTemplate;
    /** Remove a template; the active selection falls back to "none". */
    remove(name: string): {
        removed: string;
        active: string;
    };
    /** Name of the selected template, or '' when the agent uses the plain prompt. */
    activeName(): string;
    setActive(name: string): string;
    /** The instructions of the selected template, or '' when none is selected. */
    activePrompt(): string;
    private normalise;
    private write;
}
//# sourceMappingURL=prompts.d.ts.map
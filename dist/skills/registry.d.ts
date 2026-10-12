/** Codes a skill operation can fail with (mirrors `ScriptError`'s vocabulary). */
export type SkillErrorCode = 'invalid' | 'invalid_name' | 'not_found' | 'conflict' | 'io';
export declare const SKILL_VERSION = "infagent-skill/v1";
/**
 * How much of a pinned skill reaches the prompt. The whole catalogue is under
 * 1 kB per file, so these are head-room rather than everyday limits — they
 * exist so a long skill someone adds later cannot crowd out the reply.
 */
export declare const DEFAULT_ATTACHED_SKILLS = 4;
export declare const DEFAULT_SKILL_BODY_CHARS = 2000;
/** Where skills live by default: `skills/` next to the project. */
export declare const DEFAULT_SKILLS_DIR: string;
export interface SkillMeta {
    version: string;
    name: string;
    description: string;
    when: string;
    updatedAt: string;
}
export interface SkillRecord {
    meta: SkillMeta;
    file: string;
    relativePath: string;
    bytes: number;
    modifiedAt: string;
}
export interface SkillDetail extends SkillRecord {
    /** The markdown body, front matter removed. */
    body: string;
    /** The file exactly as stored. */
    source: string;
}
export declare class SkillError extends Error {
    readonly code: SkillErrorCode;
    constructor(code: SkillErrorCode, message: string);
}
export interface SkillRegistryOptions {
    /** Folder holding the skills. Defaults to `INFAGENT_SKILLS_DIR` then `skills/`. */
    root?: string;
}
/** Parse the `---` delimited header into key/value pairs. */
export declare function parseFrontMatter(source: string): {
    fields: Record<string, string>;
    body: string;
};
/** Build a complete skill file from its parts. */
export declare function renderSkill(input: {
    name: string;
    description: string;
    when?: string;
    body: string;
    updatedAt: string;
}): string;
export declare class SkillRegistry {
    readonly root: string;
    constructor(options?: SkillRegistryOptions);
    ensureRoot(): string;
    private fileFor;
    private static meta;
    list(): SkillRecord[];
    read(name: string): SkillDetail;
    search(query: string): SkillRecord[];
    create(input: {
        name: string;
        description: string;
        when?: string;
        body?: string;
        overwrite?: boolean;
    }): SkillDetail;
    update(name: string, patch: {
        description?: string;
        when?: string;
        body?: string;
    }): SkillDetail;
    remove(name: string): {
        name: string;
        file: string;
    };
    /** One-line-per-skill listing used by the prompt and the CLI. */
    listing(): string;
    /**
     * The bodies of the named skills, for a turn that pinned them.
     *
     * A missing or unreadable skill is skipped rather than raised: the name came
     * from a message box, and a skill deleted since it was typed must not turn
     * into a failed reply. Bodies are cut to `maxChars` each and the list to
     * `limit` entries, because the body lands in a system prompt that has to
     * share the window with the answer.
     */
    load(names: readonly string[], options?: {
        limit?: number;
        maxChars?: number;
    }): {
        name: string;
        body: string;
        truncated: boolean;
    }[];
    /** Compact shape sent to the UI. */
    summary(): {
        count: number;
        root: string;
        skills: SkillRecord[];
    };
}
/** Guard used by the HTTP layer to keep request bodies sane. */
export declare function asSkillInput(body: unknown): {
    name: string;
    description: string;
    when?: string;
    body?: string;
};
//# sourceMappingURL=registry.d.ts.map
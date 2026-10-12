export interface ChatSettings {
    temperature: number;
    maxTokens: number;
    thinking: boolean;
    tools: boolean;
    net: boolean;
    systemPrompt: string;
    maxSteps: number;
    /** null means every enabled MCP server; [] means none. */
    mcpServers: string[] | null;
    /** Model to use for this conversation. */
    modelId: string;
    /** Name of the shared template selected for this conversation. */
    styleName: string;
}
export interface StoredChatTurn {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    thinking: string;
    calls: Record<string, unknown>[];
    plans?: {
        text: string;
        step?: number;
    }[];
    skills?: string[];
    stats?: {
        totalTokens: number;
        tokensPerSecond: number;
        durationMs: number;
        repairs?: number;
    };
    error?: string;
    /** Always false when read back: a stream never resumes across restarts. */
    streaming?: false;
}
export interface ChatSummary {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    preview: string;
    turnCount: number;
    modelId: string;
}
export interface StoredChat extends ChatSummary {
    settings: ChatSettings;
    turns: StoredChatTurn[];
}
export interface CreateChatInput {
    title?: unknown;
    settings: unknown;
    turns?: unknown;
}
export interface ImportChatInput extends CreateChatInput {
    importId: unknown;
}
export interface ImportChatResult {
    /** null when this import was already seen and its chat has since been deleted. */
    chat: StoredChat | null;
    created: boolean;
}
export declare class ChatStoreError extends Error {
    readonly status: 400 | 404 | 409;
    constructor(status: 400 | 404 | 409, message: string);
}
export declare const DEFAULT_CHAT_SETTINGS: ChatSettings;
/**
 * Use an OS-appropriate app-data folder. `INFAGENT_DATA_DIR` is useful for
 * portable installs and tests; `INFAGENT_DB_PATH` can name one exact file.
 */
export declare function defaultChatDatabasePath(): string;
/** Fill defaults for a legacy/partial settings object and bound untrusted input. */
export declare function normaliseChatSettings(value: unknown): ChatSettings;
export declare function normaliseChatTurns(value: unknown): StoredChatTurn[];
/** SQLite-backed conversation catalogue. Safe to instantiate with `:memory:` in tests. */
export declare class ChatStore {
    readonly path: string;
    private readonly db;
    private closed;
    constructor(path?: string);
    private migrate;
    private insertChat;
    private summary;
    private summaryRows;
    list(): ChatSummary[];
    getSummary(id: string): ChatSummary | null;
    get(id: string): StoredChat | null;
    create(input: CreateChatInput): StoredChat;
    importLegacy(input: ImportChatInput): ImportChatResult;
    updateSettings(id: string, value: unknown): StoredChat | null;
    updateTitle(id: string, value: unknown): StoredChat | null;
    saveTurns(id: string, value: unknown): StoredChat | null;
    delete(id: string): boolean;
    close(): void;
}
//# sourceMappingURL=chatStore.d.ts.map
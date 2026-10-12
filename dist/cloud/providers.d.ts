import type { ChatEvent, ChatMessage } from '../chat/types.js';
export type CloudAdapter = 'openai-compatible' | 'anthropic' | 'gemini';
export interface CloudModel {
    id: string;
    name: string;
}
export interface CloudProvider {
    id: string;
    name: string;
    adapter: CloudAdapter;
    /** API root, not a model-specific endpoint. */
    baseUrl: string;
    models: CloudModel[];
    updatedAt: string;
}
export interface CloudProviderPreset {
    id: string;
    name: string;
    adapter: CloudAdapter;
    baseUrl: string;
}
export declare const CLOUD_PROVIDER_PRESETS: readonly CloudProviderPreset[];
export declare class CloudProviderError extends Error {
    readonly status: 400 | 404 | 409 | 502 | 504;
    constructor(status: 400 | 404 | 409 | 502 | 504, message: string);
}
export interface CloudCompletionRequest {
    providerId: string;
    modelId: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
    promptTemplate?: string;
}
export declare function cloudApiKeyEnvName(providerId: string): string;
export declare function defaultCloudProvidersPath(): string;
/** Small user-data store for provider endpoints and discovered model IDs. */
export declare class CloudProviderStore {
    readonly path: string;
    constructor(path?: string);
    private readFile;
    private writeFile;
    list(): CloudProvider[];
    get(id: string): CloudProvider | null;
    upsert(value: unknown): CloudProvider;
    setModels(id: string, models: CloudModel[]): CloudProvider;
    remove(id: string): CloudProvider | null;
}
/** Unified chat-completions adapter for OpenAI-compatible, Anthropic, and Gemini APIs. */
export declare class CloudInference {
    private readonly providers;
    private readonly keyResolver;
    private readonly fetcher;
    constructor(providers: CloudProviderStore, keyResolver?: (provider: CloudProvider) => string | null, fetcher?: typeof fetch);
    apiKeyConfigured(provider: CloudProvider): boolean;
    private providerAndKey;
    private request;
    listModels(id: string, signal?: AbortSignal): Promise<CloudModel[]>;
    stream(input: CloudCompletionRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
}
//# sourceMappingURL=providers.d.ts.map
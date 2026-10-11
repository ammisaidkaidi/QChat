/**
 * Minimal Server-Sent Events helpers.
 *
 * Chat and model-download progress are streams, so they use SSE rather than a
 * request/response cycle. Responses disable proxy buffering (`no-transform`,
 * `X-Accel-Buffering`) so tokens arrive as they are produced behind the preview
 * proxy.
 */
import type { ServerResponse } from 'node:http';
export interface SseStream {
    send: (payload: unknown, event?: string) => void;
    comment: (text: string) => void;
    close: () => void;
    readonly closed: boolean;
}
export declare function openSse(res: ServerResponse): SseStream;
//# sourceMappingURL=sse.d.ts.map
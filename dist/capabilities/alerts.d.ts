export type AlertLevel = 'info' | 'success' | 'warning' | 'error';
export declare const ALERT_LEVELS: readonly AlertLevel[];
export interface AlertInput {
    /** Main text of the alert. */
    message: string;
    /** Optional heading; defaults to a word derived from the level. */
    title?: string;
    /** Defaults to `info`. */
    level?: AlertLevel;
}
export interface Alert {
    id: string;
    title: string;
    message: string;
    level: AlertLevel;
    /** Who raised it: `agent`, `cli`, `api`, a script name… */
    source: string;
    /** ISO timestamp. */
    at: string;
}
export declare class AlertError extends Error {
    readonly code: 'invalid';
    constructor(message: string);
}
/** Validate whatever arrived from a tool call, a REST body or the CLI. */
export declare function asAlertInput(value: unknown): AlertInput;
/**
 * In-memory queue of the last `limit` alerts, with a tiny listener registry so
 * an SSE connection can follow along live.
 */
export declare class AlertBus {
    private readonly alerts;
    private readonly listeners;
    private readonly limit;
    constructor(options?: {
        limit?: number;
    });
    /** Raise an alert and hand it to every listener. Returns the stored record. */
    raise(input: AlertInput | unknown, source?: string): Alert;
    /** Most recent first. */
    list(limit?: number): Alert[];
    get(id: string): Alert | undefined;
    /** Drop every stored alert; returns how many were removed. */
    clear(): number;
    get size(): number;
    /** Follow alerts as they are raised. Returns an unsubscribe function. */
    subscribe(listener: (alert: Alert) => void): () => void;
}
//# sourceMappingURL=alerts.d.ts.map
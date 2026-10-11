/**
 * Alerts: the one capability whose output is meant for the human, not the model.
 *
 * When the user says "show me an alert" (or asks to be notified, warned or
 * reminded), the `showAlert` tool raises an alert on this bus. Everything that
 * can display an alert listens to the same bus:
 *
 *   - the console draws a toast (and a desktop notification if the browser
 *     allows it) through `GET /api/alerts/stream`
 *   - the chat stream forwards it as an `alert` event, so `infagent chat ask`
 *     prints it too
 *   - `infagent alert "…"` and `POST /api/alerts` raise one from outside the
 *     model, e.g. from a script that finished a long job
 *
 * The bus is in-memory on purpose: an alert matters while it is on screen, and
 * nothing here needs to survive a restart.
 */
import { randomUUID } from 'node:crypto';
export const ALERT_LEVELS = ['info', 'success', 'warning', 'error'];
export class AlertError extends Error {
    code;
    constructor(message) {
        super(message);
        this.name = 'AlertError';
        this.code = 'invalid';
    }
}
const TITLES = {
    info: 'Notice',
    success: 'Done',
    warning: 'Warning',
    error: 'Error',
};
/** Validate whatever arrived from a tool call, a REST body or the CLI. */
export function asAlertInput(value) {
    const record = typeof value === 'object' && value !== null ? value : {};
    const message = String(record['message'] ?? record['text'] ?? '').trim();
    if (!message)
        throw new AlertError('An alert needs a `message`.');
    const level = String(record['level'] ?? 'info')
        .toLowerCase()
        .trim();
    if (!ALERT_LEVELS.includes(level)) {
        throw new AlertError(`Unknown alert level "${level}". Use ${ALERT_LEVELS.join(', ')}.`);
    }
    const title = String(record['title'] ?? '').trim();
    return {
        message: message.slice(0, 400),
        title: (title || TITLES[level]).slice(0, 80),
        level: level,
    };
}
/**
 * In-memory queue of the last `limit` alerts, with a tiny listener registry so
 * an SSE connection can follow along live.
 */
export class AlertBus {
    alerts = [];
    listeners = new Set();
    limit;
    constructor(options = {}) {
        this.limit = Math.max(options.limit ?? 50, 1);
    }
    /** Raise an alert and hand it to every listener. Returns the stored record. */
    raise(input, source = 'agent') {
        const valid = asAlertInput(input);
        const alert = {
            id: randomUUID(),
            title: valid.title ?? TITLES[valid.level ?? 'info'],
            message: valid.message,
            level: valid.level ?? 'info',
            source,
            at: new Date().toISOString(),
        };
        this.alerts.push(alert);
        if (this.alerts.length > this.limit)
            this.alerts.splice(0, this.alerts.length - this.limit);
        for (const listener of this.listeners) {
            try {
                listener(alert);
            }
            catch {
                // A broken listener must never break the tool call that raised the alert.
            }
        }
        return alert;
    }
    /** Most recent first. */
    list(limit = 20) {
        return [...this.alerts].reverse().slice(0, Math.max(limit, 0));
    }
    get(id) {
        return this.alerts.find((alert) => alert.id === id);
    }
    /** Drop every stored alert; returns how many were removed. */
    clear() {
        const removed = this.alerts.length;
        this.alerts.length = 0;
        return removed;
    }
    get size() {
        return this.alerts.length;
    }
    /** Follow alerts as they are raised. Returns an unsubscribe function. */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}
//# sourceMappingURL=alerts.js.map
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

export type AlertLevel = 'info' | 'success' | 'warning' | 'error';

export const ALERT_LEVELS: readonly AlertLevel[] = ['info', 'success', 'warning', 'error'];

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

export class AlertError extends Error {
  public readonly code: 'invalid';

  constructor(message: string) {
    super(message);
    this.name = 'AlertError';
    this.code = 'invalid';
  }
}

const TITLES: Record<AlertLevel, string> = {
  info: 'Notice',
  success: 'Done',
  warning: 'Warning',
  error: 'Error',
};

/** Validate whatever arrived from a tool call, a REST body or the CLI. */
export function asAlertInput(value: unknown): AlertInput {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

  const message = String(record['message'] ?? record['text'] ?? '').trim();
  if (!message) throw new AlertError('An alert needs a `message`.');

  const level = String(record['level'] ?? 'info')
    .toLowerCase()
    .trim();
  if (!ALERT_LEVELS.includes(level as AlertLevel)) {
    throw new AlertError(`Unknown alert level "${level}". Use ${ALERT_LEVELS.join(', ')}.`);
  }

  const title = String(record['title'] ?? '').trim();

  return {
    message: message.slice(0, 400),
    title: (title || TITLES[level as AlertLevel]).slice(0, 80),
    level: level as AlertLevel,
  };
}

/**
 * In-memory queue of the last `limit` alerts, with a tiny listener registry so
 * an SSE connection can follow along live.
 */
export class AlertBus {
  private readonly alerts: Alert[] = [];
  private readonly listeners = new Set<(alert: Alert) => void>();
  private readonly limit: number;

  constructor(options: { limit?: number } = {}) {
    this.limit = Math.max(options.limit ?? 50, 1);
  }

  /** Raise an alert and hand it to every listener. Returns the stored record. */
  raise(input: AlertInput | unknown, source = 'agent'): Alert {
    const valid = asAlertInput(input);
    const alert: Alert = {
      id: randomUUID(),
      title: valid.title ?? TITLES[valid.level ?? 'info'],
      message: valid.message,
      level: valid.level ?? 'info',
      source,
      at: new Date().toISOString(),
    };

    this.alerts.push(alert);
    if (this.alerts.length > this.limit) this.alerts.splice(0, this.alerts.length - this.limit);

    for (const listener of this.listeners) {
      try {
        listener(alert);
      } catch {
        // A broken listener must never break the tool call that raised the alert.
      }
    }

    return alert;
  }

  /** Most recent first. */
  list(limit = 20): Alert[] {
    return [...this.alerts].reverse().slice(0, Math.max(limit, 0));
  }

  get(id: string): Alert | undefined {
    return this.alerts.find((alert) => alert.id === id);
  }

  /** Drop every stored alert; returns how many were removed. */
  clear(): number {
    const removed = this.alerts.length;
    this.alerts.length = 0;
    return removed;
  }

  get size(): number {
    return this.alerts.length;
  }

  /** Follow alerts as they are raised. Returns an unsubscribe function. */
  subscribe(listener: (alert: Alert) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

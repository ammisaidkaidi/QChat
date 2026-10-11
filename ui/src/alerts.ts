/**
 * Alert store: one place where every alert that arrives is kept, whichever path
 * it took (the model's `showAlert` tool, the CLI, a script posting to the API).
 *
 * The console opens a single Server-Sent Events connection to
 * `/api/alerts/stream` while it is open; chat turns also carry `alert` events,
 * so a showAlert call shows up even if the stream is not connected yet. Alerts
 * are keyed by id, so receiving the same one twice shows a single toast.
 */
import { computed, ref } from 'vue';

import { alertsApi } from './api';
import type { AlertRecord } from './types';

const alerts = ref<AlertRecord[]>([]);
const MAX_VISIBLE = 3;

/** How long a toast stays before it fades, per level (ms). */
const LIFETIME: Record<AlertRecord['level'], number> = {
  info: 12_000,
  success: 12_000,
  warning: 20_000,
  error: 25_000,
};

const timers = new Map<string, number>();

/**
 * Watermark of the newest alert the user has already seen, so reloading the
 * page does not resurrect alerts from a previous session — but an alert raised
 * while the console was closed still shows up once.
 */
const SEEN_KEY = 'infagent.alert.seenAt';

function readWatermark(): number {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const value = raw ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}

function writeWatermark(iso: string): void {
  try {
    localStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* private mode — alerts simply replay on the next reload */
  }
}

function scheduleRemoval(alert: AlertRecord): void {
  if (typeof window === 'undefined') return;
  const timer = window.setTimeout(() => dismiss(alert.id), LIFETIME[alert.level]);
  timers.set(alert.id, timer);
}

/** Mirror the alert on the desktop when the tab is in the background. */
function notifyDesktop(alert: AlertRecord): void {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && !document.hidden) return;
  try {
    new Notification(`${alert.title} — InfAgent`, { body: alert.message });
  } catch {
    // Some browsers refuse notifications outside a service worker; the toast remains.
  }
}

/** Add an alert (idempotent by id) and start its dismissal timer. */
export function pushAlert(alert: AlertRecord): void {
  if (alerts.value.some((existing) => existing.id === alert.id)) return;
  writeWatermark(alert.at);
  alerts.value = [...alerts.value, alert].slice(-MAX_VISIBLE);
  scheduleRemoval(alert);
  notifyDesktop(alert);
}

/** Adopt a batch from `GET /api/alerts`, skipping what the user already saw. */
export function adoptAlerts(list: AlertRecord[]): void {
  const watermark = readWatermark();
  const fresh = list
    .filter((alert) => Date.parse(alert.at) > watermark)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));

  for (const alert of fresh) {
    if (alerts.value.some((existing) => existing.id === alert.id)) continue;
    alerts.value = [...alerts.value, alert].slice(-MAX_VISIBLE);
    scheduleRemoval(alert);
  }

  const newest = list[0];
  if (newest) writeWatermark(newest.at);
}

export function dismiss(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(id);
  }
  alerts.value = alerts.value.filter((alert) => alert.id !== id);
}

export function dismissAll(): void {
  for (const alert of [...alerts.value]) dismiss(alert.id);
}

/** Raise an alert from the interface (used by the toolbar bell button). */
export async function raiseAlert(input: {
  message: string;
  title?: string;
  level?: AlertRecord['level'];
}): Promise<AlertRecord> {
  const { alert } = await alertsApi.raise(input);
  pushAlert(alert);
  return alert;
}

export const alertState = {
  visible: computed(() => alerts.value),
  count: computed(() => alerts.value.length),
};

let source: EventSource | null = null;

/** Subscribe to the live feed; safe to call once, on app mount. */
export function startAlertStream(): () => void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {};

  // Only the two newest, so reopening the console never replays a wall of
  // alerts raised while it was closed.
  void alertsApi
    .list(2)
    .then((payload) => adoptAlerts(payload.alerts))
    .catch(() => {
      // An unreachable list endpoint only means there is nothing to catch up on.
    });

  if (source) return () => stopAlertStream();

  source = new EventSource(alertsApi.streamUrl);
  source.addEventListener('alert', (event) => {
    try {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as { alert: AlertRecord };
      if (parsed.alert) pushAlert(parsed.alert);
    } catch {
      // A malformed frame is dropped; the list endpoint still has the truth.
    }
  });

  return () => stopAlertStream();
}

export function stopAlertStream(): void {
  source?.close();
  source = null;
}

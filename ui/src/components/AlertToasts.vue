<script setup lang="ts">
/**
 * Toast stack for alerts raised by the model (`showAlert`), the CLI
 * (`infagent alert "…"`) or any script posting to `/api/alerts`.
 *
 * The store keeps at most four on screen; each one can be dismissed by hand and
 * otherwise disappears on its own after a few seconds.
 */
import { alertState, dismiss, dismissAll } from '../alerts';
import type { AlertLevel } from '../types';

// Computed refs, so the template reads them without `.value`.
const visible = alertState.visible;
const count = alertState.count;

const TONE: Record<AlertLevel, string> = {
  info: 'alert-info',
  success: 'alert-success',
  warning: 'alert-warning',
  error: 'alert-error',
};

const ICON: Record<AlertLevel, string> = {
  info: '🔔',
  success: '✅',
  warning: '⚠️',
  error: '⛔',
};

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <div
    class="toast toast-end toast-bottom z-50 m-3 max-w-[calc(100vw-1.5rem)] gap-2 sm:max-w-sm"
    role="status"
    aria-live="polite"
  >
    <div
      v-for="alert in visible"
      :key="alert.id"
      class="alert alert-soft items-start shadow-lg"
      :class="TONE[alert.level]"
      data-testid="alert-toast"
    >
      <span class="text-base leading-none">{{ ICON[alert.level] }}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-semibold">{{ alert.title }}</p>
        <p class="text-xs whitespace-pre-wrap break-words">{{ alert.message }}</p>
        <p class="mt-1 font-mono text-[10px] opacity-60">
          {{ alert.source }} · {{ clock(alert.at) }}
        </p>
      </div>
      <button
        class="btn btn-ghost btn-xs"
        title="Dismiss this alert"
        @click="dismiss(alert.id)"
      >
        ✕
      </button>
    </div>

    <button
      v-if="count > 1"
      class="btn btn-ghost btn-xs self-end bg-base-100/80"
      @click="dismissAll"
    >
      Dismiss all
    </button>
  </div>
</template>

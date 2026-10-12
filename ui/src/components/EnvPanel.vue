<script setup lang="ts">
/**
 * Config tab: edit `.env` from the console.
 *
 * Secrets are shown as a mask with a "set / not set" state — the server never
 * sends their values to the browser, so a secret can only be replaced, never
 * read back. Everything is written in one explicit Save, which keeps a `.bak`
 * copy of the previous file next to it.
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { envApi } from '../api';
import type { EnvEntry } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const entries = ref<EnvEntry[]>([]);
const filePath = ref('');
const referencePath = ref('');
const mask = ref('••••••');
const exists = ref(false);
const loading = ref(true);
const saving = ref(false);
const filter = ref('');
const reveal = reactive<Record<string, boolean>>({});
/** Only what the user touched is sent: untouched secrets stay untouched. */
const draft = reactive<Record<string, string>>({});
const removed = reactive<Record<string, boolean>>({});

const dirty = computed(() => Object.keys(draft).length > 0 || Object.keys(removed).length > 0);

const groups = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const visible = entries.value.filter(
    (entry) =>
      !needle ||
      entry.key.toLowerCase().includes(needle) ||
      entry.note.toLowerCase().includes(needle) ||
      entry.group.toLowerCase().includes(needle),
  );

  const byGroup = new Map<string, EnvEntry[]>();
  for (const entry of visible) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  return [...byGroup.entries()].map(([name, items]) => ({ name, items }));
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const snapshot = await envApi.read();
    entries.value = snapshot.entries;
    filePath.value = snapshot.path;
    referencePath.value = snapshot.reference;
    mask.value = snapshot.mask;
    exists.value = snapshot.exists;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

function reset(): void {
  for (const key of Object.keys(draft)) delete draft[key];
  for (const key of Object.keys(removed)) delete removed[key];
}

function edit(entry: EnvEntry, value: string): void {
  deleted(entry.key, false);
  if (value === entry.masked) {
    delete draft[entry.key];
    return;
  }
  draft[entry.key] = value;
}

function deleted(key: string, value: boolean): void {
  if (value) {
    removed[key] = true;
    delete draft[key];
  } else {
    delete removed[key];
  }
}

async function save(): Promise<void> {
  const updates: Record<string, string> = {};
  const remove: string[] = [];

  for (const [key, value] of Object.entries(draft)) {
    if (updates[key] === mask.value) continue;
    updates[key] = value;
  }
  for (const key of Object.keys(removed)) remove.push(key);

  if (Object.keys(updates).length === 0 && remove.length === 0) {
    emit('notify', 'Nothing changed.', 'error');
    return;
  }

  saving.value = true;
  try {
    const result = await envApi.save({ updates, remove });
    entries.value = result.snapshot.entries;
    exists.value = result.snapshot.exists;
    reset();
    const written = [...result.changed, ...result.removed.map((key) => `${key} (removed)`)];
    emit(
      'notify',
      `Saved ${written.join(', ')}${result.backup ? ' · backup .env.bak' : ''}`,
      'success',
    );
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold">
              Environment
              <span class="badge badge-ghost badge-sm ml-1">{{ entries.length }} keys</span>
            </h2>
            <p class="truncate font-mono text-[11px] opacity-60" :title="filePath">
              {{ filePath }}{{ exists ? '' : ' (will be created)' }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="filter"
              class="input input-bordered input-xs w-40 font-mono"
              placeholder="filter keys…"
            />
            <button class="btn btn-ghost btn-xs" :disabled="saving" @click="load">Reload</button>
            <button class="btn btn-primary btn-xs" :disabled="!dirty || saving" @click="save">
              <span v-if="saving" class="loading loading-xs loading-spinner"></span>
              Save
            </button>
          </div>
        </header>

        <div
          class="rounded-box border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] leading-snug"
        >
          Values are written straight into <span class="font-mono">{{ filePath }}</span
          >, which is gitignored — it never enters the repository. Credentials (tokens, passwords,
          keys) are shown masked; leave a field untouched and its value is kept as it is. The
          previous file is kept as <span class="font-mono">.env.bak</span>. Comments are read from
          <span class="font-mono">{{ referencePath }}</span
          >; the live process picks values up immediately, an MCP server needs a restart.
        </div>

        <p v-if="loading" class="py-6 text-center text-xs opacity-60">loading…</p>

        <div v-else class="space-y-4">
          <div v-for="group in groups" :key="group.name" class="space-y-2">
            <p class="text-[11px] font-semibold uppercase tracking-wide opacity-50">
              {{ group.name }}
            </p>

            <div
              v-for="entry in group.items"
              :key="entry.key"
              class="grid gap-1 border-b border-base-300/60 pb-2 last:border-0 sm:grid-cols-[16rem_1fr]"
            >
              <div class="min-w-0">
                <p class="truncate font-mono text-xs" :title="entry.key">
                  {{ entry.key }}
                  <span v-if="entry.secret" class="badge badge-warning badge-xs ml-1">secret</span>
                  <span v-else-if="!entry.set" class="badge badge-ghost badge-xs ml-1">unset</span>
                </p>
                <p v-if="entry.note" class="text-[10px] leading-snug opacity-50">
                  {{ entry.note }}
                </p>
              </div>

              <div class="flex items-center gap-2">
                <input
                  :value="removed[entry.key] ? '' : (draft[entry.key] ?? entry.masked)"
                  :type="entry.secret && !reveal[entry.key] ? 'password' : 'text'"
                  :placeholder="entry.secret && entry.set ? 'leave empty to keep' : 'value'"
                  class="input input-bordered input-xs min-w-0 flex-1 font-mono"
                  :disabled="!!removed[entry.key]"
                  :aria-label="`Value of ${entry.key}`"
                  @input="edit(entry, ($event.target as HTMLInputElement).value)"
                />
                <button
                  v-if="entry.secret"
                  class="btn btn-ghost btn-xs"
                  :title="reveal[entry.key] ? 'Hide' : 'Show what you typed'"
                  @click="reveal[entry.key] = !reveal[entry.key]"
                >
                  {{ reveal[entry.key] ? '🙈' : '👁' }}
                </button>
                <label class="flex cursor-pointer items-center gap-1 text-[10px] opacity-70">
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    :checked="!!removed[entry.key]"
                    @change="deleted(entry.key, ($event.target as HTMLInputElement).checked)"
                  />
                  remove
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

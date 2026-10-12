<script setup lang="ts">
/**
 * Config tab: edit `.env` from the console.
 *
 * A normal load never carries a credential: secrets arrive as a mask plus a
 * "set / not set" state. Two explicit actions change that — the eye next to one
 * key asks the server for that single value, and "Reveal secrets" asks for all
 * of them at once — and both are reversible with the same click.
 *
 * New variables are added with the button in the header and are written
 * together with the edited ones on Save, which keeps a `.bak` copy first.
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { envApi } from '../api';
import type { EnvEntry } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

/** What a shell — and `src/config/envFile.ts` — accepts as a variable name. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const entries = ref<EnvEntry[]>([]);
const filePath = ref('');
const referencePath = ref('');
const mask = ref('••••••');
const exists = ref(false);
const loading = ref(true);
const saving = ref(false);
const filter = ref('');
/** Only what the user touched is sent: untouched secrets stay untouched. */
const draft = reactive<Record<string, string>>({});
const removed = reactive<Record<string, boolean>>({});
/** Plaintext fetched on demand; `key in revealed` means "showing it". */
const revealed = reactive<Record<string, string>>({});
const revealing = reactive<Record<string, boolean>>({});
const revealAll = ref(false);
/** Variables typed in the "add" form and not saved yet. */
const additions = ref<{ key: string; value: string }[]>([]);
const addOpen = ref(false);
const newKey = ref('');
const newValue = ref('');

const dirty = computed(
  () =>
    Object.keys(draft).length > 0 || Object.keys(removed).length > 0 || additions.value.length > 0,
);

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
    forgetRevealed();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

function forgetRevealed(): void {
  for (const key of Object.keys(revealed)) delete revealed[key];
  revealAll.value = false;
}

function reset(): void {
  for (const key of Object.keys(draft)) delete draft[key];
  for (const key of Object.keys(removed)) delete removed[key];
  additions.value = [];
  addOpen.value = false;
  newKey.value = '';
  newValue.value = '';
}

/** The value the field shows when the user has not edited it. */
function shown(entry: EnvEntry): string {
  if (removed[entry.key]) return '';
  const current = draft[entry.key] ?? revealed[entry.key] ?? entry.masked;
  return current;
}

function edit(entry: EnvEntry, value: string): void {
  deleted(entry.key, false);
  const baseline = revealed[entry.key] ?? entry.masked;
  if (value === baseline) {
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

async function toggleReveal(entry: EnvEntry): Promise<void> {
  if (entry.key in revealed) {
    delete revealed[entry.key];
    revealAll.value = false;
    return;
  }
  revealing[entry.key] = true;
  try {
    const result = await envApi.reveal(entry.key);
    revealed[entry.key] = result.value;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    delete revealing[entry.key];
  }
}

async function toggleRevealAll(): Promise<void> {
  if (revealAll.value) {
    forgetRevealed();
    return;
  }
  try {
    const result = await envApi.revealAll();
    const keys = Object.keys(result.values);
    for (const [key, value] of Object.entries(result.values)) revealed[key] = value;
    revealAll.value = true;
    if (keys.length === 0) emit('notify', 'No credential is set yet.', 'error');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

function addVariable(): void {
  const key = newKey.value.trim();
  const value = newValue.value;
  if (!KEY_PATTERN.test(key)) {
    emit('notify', `"${key}" is not a valid variable name (letters, digits and _ only).`, 'error');
    return;
  }

  const existing = entries.value.find((entry) => entry.key === key);
  if (existing) {
    edit(existing, value);
    emit('notify', `${key} already exists — its value is updated in place.`, 'success');
  } else {
    const pending = additions.value.find((item) => item.key === key);
    if (pending) pending.value = value;
    else additions.value.push({ key, value });
  }

  newKey.value = '';
  newValue.value = '';
  addOpen.value = false;
}

function dropAddition(key: string): void {
  additions.value = additions.value.filter((item) => item.key !== key);
}

async function save(): Promise<void> {
  const updates: Record<string, string> = {};
  const remove: string[] = [];

  for (const [key, value] of Object.entries(draft)) {
    if (updates[key] === mask.value) continue;
    updates[key] = value;
  }
  for (const item of additions.value) updates[item.key] = item.value;
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
    forgetRevealed();
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
              <span v-if="additions.length" class="badge badge-primary badge-sm ml-1">
                +{{ additions.length }} new
              </span>
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
            <button
              class="btn btn-ghost btn-xs"
              :title="
                revealAll ? 'Hide every revealed value' : 'Fetch and show every credential value'
              "
              @click="toggleRevealAll"
            >
              {{ revealAll ? '🙈 Hide secrets' : '👁 Reveal secrets' }}
            </button>
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
          >, which is gitignored — it never enters the repository. Credentials stay masked until you
          ask for them: the eye next to a key fetches that one value, and
          <span class="font-mono">Reveal secrets</span> fetches all of them. A revealed value is
          plain text on screen, so a screenshot or a shared screen would show it. Leave a field
          untouched and its value is kept as it is; the previous file is kept as
          <span class="font-mono">.env.bak</span>. Comments are read from
          <span class="font-mono">{{ referencePath }}</span
          >; the live process picks values up immediately, an MCP server needs a restart.
        </div>

        <div
          v-if="addOpen"
          class="flex flex-wrap items-end gap-2 rounded-box border border-primary/40 bg-primary/5 px-3 py-2"
        >
          <label class="flex flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-wide opacity-50">Name</span>
            <input
              v-model="newKey"
              aria-label="New variable name"
              class="input input-bordered input-xs w-56 font-mono"
              placeholder="MY_VARIABLE"
              @keyup.enter="addVariable"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[10px] font-semibold uppercase tracking-wide opacity-50">Value</span>
            <input
              v-model="newValue"
              aria-label="New variable value"
              class="input input-bordered input-xs w-64 font-mono"
              placeholder="value"
              @keyup.enter="addVariable"
            />
          </label>
          <button class="btn btn-primary btn-xs" @click="addVariable">Add</button>
          <button class="btn btn-ghost btn-xs" @click="addOpen = false">Cancel</button>
          <p class="w-full text-[10px] opacity-60">
            Written on Save, under a
            <span class="font-mono"># ---- added from the console ----</span> banner.
          </p>
        </div>

        <p v-if="loading" class="py-6 text-center text-xs opacity-60">loading…</p>

        <div v-else class="space-y-4">
          <div v-if="additions.length" class="space-y-2">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-primary">
              new variables (not saved yet)
            </p>
            <div
              v-for="item in additions"
              :key="item.key"
              class="grid gap-1 border-b border-base-300/60 pb-2 sm:grid-cols-[16rem_1fr]"
            >
              <div class="min-w-0">
                <p class="truncate font-mono text-xs" :title="item.key">
                  {{ item.key }}
                  <span class="badge badge-primary badge-xs ml-1">new</span>
                </p>
              </div>
              <div class="flex items-center gap-2">
                <input
                  v-model="item.value"
                  class="input input-bordered input-xs min-w-0 flex-1 font-mono"
                  :aria-label="`Value of ${item.key}`"
                  placeholder="value"
                />
                <button class="btn btn-ghost btn-xs" title="Remove" @click="dropAddition(item.key)">
                  ✕
                </button>
              </div>
            </div>
          </div>

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
                <!-- The badges wrap instead of being clipped when a key is long. -->
                <p class="flex flex-wrap items-center gap-1 font-mono text-xs">
                  <span class="truncate" :title="entry.key">{{ entry.key }}</span>
                  <span v-if="entry.secret" class="badge badge-warning badge-xs">secret</span>
                  <span v-else-if="!entry.set" class="badge badge-ghost badge-xs">unset</span>
                  <span
                    v-if="entry.key in revealed"
                    class="badge badge-error badge-xs"
                    title="The real value is on screen"
                    >shown</span
                  >
                </p>
                <p v-if="entry.note" class="text-[10px] leading-snug opacity-50">
                  {{ entry.note }}
                </p>
              </div>

              <div class="flex items-center gap-2">
                <input
                  :value="shown(entry)"
                  :type="entry.secret && !(entry.key in revealed) ? 'password' : 'text'"
                  :placeholder="entry.secret && entry.set ? 'leave empty to keep' : 'value'"
                  class="input input-bordered input-xs min-w-0 flex-1 font-mono"
                  :disabled="!!removed[entry.key]"
                  :aria-label="`Value of ${entry.key}`"
                  @input="edit(entry, ($event.target as HTMLInputElement).value)"
                />
                <button
                  v-if="entry.secret"
                  class="btn btn-ghost btn-xs"
                  :title="
                    entry.key in revealed
                      ? 'Hide the value again'
                      : entry.set
                        ? 'Fetch and show this value'
                        : 'Nothing to show — the key is unset'
                  "
                  :disabled="revealing[entry.key] || (!entry.set && !(entry.key in revealed))"
                  @click="toggleReveal(entry)"
                >
                  <span
                    v-if="revealing[entry.key]"
                    class="loading loading-xs loading-spinner"
                  ></span>
                  <template v-else>{{ entry.key in revealed ? '🙈' : '👁' }}</template>
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

        <footer class="flex flex-wrap items-center justify-between gap-2">
          <button class="btn btn-outline btn-xs" @click="addOpen = !addOpen">
            ＋ Add variable
          </button>
          <p v-if="dirty" class="text-[10px] opacity-60">
            unsaved changes — press Save to write them
          </p>
        </footer>
      </div>
    </section>
  </div>
</template>

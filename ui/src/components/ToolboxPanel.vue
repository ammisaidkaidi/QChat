<script setup lang="ts">
/**
 * Toolbox tab: the tool files the toolbox MCP server loads.
 *
 * Everything here acts on real files under the root `mcp.json` configures —
 * create, edit, upload, rename-by-saving, delete — and every write ends with
 * the server's own reload report, so what you see is what the model can call.
 * The server's rules are the interface's rules: `.js`/`.mjs`, a plain name, one
 * default export, 64 kB, 32 files.
 */
import { computed, onMounted, ref } from 'vue';

import { toolboxApi } from '../api';
import type { ToolboxReload, ToolboxSnapshot } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const snapshot = ref<ToolboxSnapshot | null>(null);
const selected = ref<string | null>(null);
const content = ref('');
const original = ref('');
const busy = ref(false);
const uploading = ref(false);
const dragging = ref(false);
const showNew = ref(false);
const newName = ref('');
const lastReload = ref<ToolboxReload | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const files = computed(() => snapshot.value?.files ?? []);
const dirty = computed(() => content.value !== original.value);
const toolCount = computed(() => snapshot.value?.tools.length ?? 0);

const TEMPLATE = `/**
 * A tool file. Anything exported by default is offered to the chat as
 * \`toolbox__<name>\`; the callback's return value is the tool's result.
 */
export default [
  {
    name: 'hello',
    description: 'Say hello to someone.',
    inputSchema: {
      type: 'object',
      properties: { who: { type: 'string', description: 'Name to greet.' } },
      required: ['who'],
    },
    callback: ({ who }) => ({ greeting: \`Hello \${who}!\` }),
  },
];
`;

async function load(keepSelection = true): Promise<void> {
  try {
    const next = await toolboxApi.list();
    snapshot.value = next;
    if (!keepSelection || !next.files.some((file) => file.name === selected.value)) {
      const first = next.files[0]?.name ?? null;
      if (first) await open(first);
      else {
        selected.value = null;
        content.value = '';
        original.value = '';
      }
    }
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function open(name: string): Promise<void> {
  if (
    dirty.value &&
    selected.value &&
    !window.confirm(`Discard the unsaved changes to ${selected.value}?`)
  ) {
    return;
  }
  try {
    const file = await toolboxApi.read(name);
    selected.value = file.name;
    content.value = file.content;
    original.value = file.content;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

/** The one write path: save, then say what the server did with it. */
async function save(name: string | null, body: string): Promise<boolean> {
  const target = (name ?? selected.value ?? '').trim();
  if (!target) {
    emit('notify', 'A file name is required.', 'error');
    return false;
  }
  busy.value = true;
  try {
    const result = await toolboxApi.save(target, body);
    lastReload.value = result.reload;
    const added = result.reload.added.length;
    emit(
      'notify',
      added > 0
        ? `${target} saved — ${result.reload.added.join(', ')} is now callable`
        : `${target} saved (${result.file.bytes} bytes)`,
      'success',
    );
    selected.value = target;
    original.value = body;
    await load();
    return true;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
    return false;
  } finally {
    busy.value = false;
  }
}

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!/\.(js|mjs)$/i.test(name)) {
    emit('notify', 'The name must end in .js or .mjs.', 'error');
    return;
  }
  if (await save(name, TEMPLATE)) {
    showNew.value = false;
    newName.value = '';
    await open(name);
  }
}

async function remove(name: string): Promise<void> {
  if (!window.confirm(`Delete ${name}? Any tool it exports stops being callable.`)) return;
  busy.value = true;
  try {
    const result = await toolboxApi.remove(name);
    lastReload.value = result.reload;
    emit(
      'notify',
      result.reload.removed.length > 0
        ? `${name} deleted — ${result.reload.removed.join(', ')} is gone`
        : `${name} deleted`,
      'success',
    );
    if (selected.value === name) {
      selected.value = null;
      content.value = '';
      original.value = '';
    }
    await load(false);
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

async function reload(): Promise<void> {
  busy.value = true;
  try {
    const { reload: report } = await toolboxApi.reload();
    lastReload.value = report;
    emit('notify', report.ok ? 'Toolbox reloaded' : report.text, report.ok ? 'success' : 'error');
    await load();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

/** Uploads arrive as text: a tool file is source, never a binary. */
async function upload(list: FileList | File[]): Promise<void> {
  const chosen = [...list];
  if (chosen.length === 0) return;
  uploading.value = true;
  try {
    for (const file of chosen) {
      const name = file.name.replace(/\.(mjs|js)$/i, (match) => match.toLowerCase());
      if (!/\.(js|mjs)$/i.test(name)) {
        emit('notify', `${file.name} skipped: only .js and .mjs tool files are loaded.`, 'error');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- one save per file, reported one by one
      const ok = await save(name, await file.text());
      if (ok) await open(name);
    }
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

function pick(): void {
  fileInput.value?.click();
}

function drop(event: DragEvent): void {
  dragging.value = false;
  const list = event.dataTransfer?.files;
  if (list && list.length > 0) void upload(list);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

onMounted(load);
</script>

<template>
  <div class="grid gap-4">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="text-sm font-semibold">Tool files</h2>
            <p class="truncate font-mono text-[11px] opacity-60">
              {{ snapshot?.root ?? 'mcp/tools' }} · {{ files.length }}/{{
                snapshot?.limits.maxFiles ?? 32
              }}
              files · {{ toolCount }} tool(s) the model can call
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span
              v-if="snapshot"
              class="badge badge-sm"
              :class="{
                'badge-success': snapshot.server.state === 'ready',
                'badge-warning': snapshot.server.state !== 'ready',
              }"
            >
              {{ snapshot.server.state }}
            </span>
            <button class="btn btn-ghost btn-xs" :disabled="busy" @click="load()">⟳ Refresh</button>
            <button class="btn btn-ghost btn-xs" :disabled="busy" @click="reload">
              ↻ Reload server
            </button>
            <button class="btn btn-ghost btn-xs" @click="pick">⬆ Upload</button>
            <button class="btn btn-primary btn-xs" @click="showNew = !showNew">
              {{ showNew ? 'Close' : '+ New file' }}
            </button>
          </div>
        </header>

        <input
          ref="fileInput"
          type="file"
          accept=".js,.mjs,text/javascript"
          multiple
          class="hidden"
          data-testid="toolbox-upload"
          @change="upload(($event.target as HTMLInputElement).files ?? [])"
        />

        <div
          v-if="showNew"
          class="flex flex-wrap items-center gap-2 rounded-box border border-base-300 p-2"
        >
          <input
            v-model="newName"
            class="input input-bordered input-xs w-56 font-mono"
            placeholder="my-tools.js"
            data-testid="toolbox-new-name"
          />
          <button
            class="btn btn-primary btn-xs"
            :disabled="busy || !newName.trim()"
            @click="create"
          >
            Create with template
          </button>
          <span class="text-[11px] opacity-60">lower case, ends in .js or .mjs</span>
        </div>

        <p
          v-if="dragging"
          class="rounded-box border border-dashed border-primary p-3 text-center text-xs"
        >
          Drop .js / .mjs tool files to upload them
        </p>

        <p class="rounded-box bg-warning/10 px-2 py-1 text-[11px] opacity-80">
          A tool file is code you installed: its callback runs in the toolbox server, not in a
          sandbox. Code written by the model belongs somewhere it is contained —
          <span class="font-mono">code__run_javascript</span>.
        </p>
      </div>
    </section>

    <div class="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <section
        class="card border border-base-300 bg-base-200/50"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="drop($event)"
      >
        <div class="card-body gap-1 p-2">
          <p v-if="files.length === 0" class="p-3 text-xs opacity-70">
            No tool files yet. Create one, or drop a <span class="font-mono">.js</span> file here:
            every file exports <span class="font-mono">[{ name, description, callback }]</span> by
            default.
          </p>
          <button
            v-for="file in files"
            :key="file.name"
            class="flex w-full items-center justify-between gap-2 rounded-box px-2 py-1.5 text-left hover:bg-base-300/50"
            :class="{ 'bg-base-300/70': selected === file.name }"
            :data-testid="`toolbox-file-${file.name}`"
            @click="open(file.name)"
          >
            <span class="min-w-0">
              <span class="block truncate font-mono text-xs">{{ file.name }}</span>
              <span class="block truncate text-[11px] opacity-60">
                <template v-if="file.tools.length > 0">
                  {{ file.tools.map((tool) => `toolbox__${tool}`).join(', ') }}
                </template>
                <template v-else-if="file.loaded === false">refused by the server</template>
                <template v-else>not loaded</template>
              </span>
            </span>
            <span class="flex shrink-0 items-center gap-1">
              <span class="text-[11px] opacity-50">{{ kb(file.bytes) }}</span>
              <span v-if="file.loaded === true" class="badge badge-success badge-xs" title="loaded"
                >✓</span
              >
              <span
                v-else-if="file.loaded === false"
                class="badge badge-error badge-xs"
                title="refused"
                >!</span
              >
              <span v-else class="badge badge-ghost badge-xs" title="server not running">–</span>
            </span>
          </button>

          <ul v-if="snapshot?.refused.length" class="mt-1 grid gap-1 p-1">
            <li
              v-for="line in snapshot.refused"
              :key="line"
              class="rounded-box bg-error/10 px-2 py-1 text-[11px] text-error"
            >
              {{ line }}
            </li>
          </ul>
        </div>
      </section>

      <section class="card border border-base-300 bg-base-200/50">
        <div class="card-body gap-2 p-3">
          <template v-if="selected">
            <header class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <h3 class="font-mono text-sm">{{ selected }}</h3>
                <span v-if="dirty" class="badge badge-warning badge-xs">unsaved</span>
              </div>
              <div class="flex items-center gap-2">
                <button class="btn btn-ghost btn-xs" :disabled="busy" @click="open(selected)">
                  Revert
                </button>
                <button
                  class="btn btn-ghost btn-xs text-error"
                  :disabled="busy"
                  @click="remove(selected)"
                >
                  Delete
                </button>
                <button
                  class="btn btn-primary btn-xs"
                  :disabled="busy || !dirty"
                  data-testid="toolbox-save"
                  @click="save(selected, content)"
                >
                  {{ busy ? 'Saving…' : 'Save & reload' }}
                </button>
              </div>
            </header>

            <textarea
              v-model="content"
              spellcheck="false"
              class="textarea textarea-bordered h-[26rem] w-full font-mono text-xs leading-relaxed"
              data-testid="toolbox-editor"
            ></textarea>

            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] opacity-70">
              <span>
                {{ content.length }} characters · saved files only become callable after the reload
                that follows a save
              </span>
              <span v-if="lastReload" class="font-mono">
                last reload:
                <template v-if="lastReload.added.length"
                  >+{{ lastReload.added.join(', ') }}</template
                >
                <template v-if="lastReload.removed.length">
                  −{{ lastReload.removed.join(', ') }}</template
                >
                <template v-if="!lastReload.added.length && !lastReload.removed.length">
                  no change
                </template>
              </span>
            </div>

            <p
              v-if="lastReload && !lastReload.ok"
              class="rounded-box bg-error/10 p-2 text-[11px] text-error"
            >
              {{ lastReload.text }}
            </p>
          </template>

          <p v-else class="p-3 text-xs opacity-70">
            Select a file to edit it, or create one. A file may export several tools:
            <span class="font-mono"
              >export default [{ name, description, inputSchema?, callback }]</span
            >.
          </p>
        </div>
      </section>
    </div>

    <section
      v-if="snapshot && snapshot.tools.length > 0"
      class="card border border-base-300 bg-base-200/40"
    >
      <div class="card-body gap-2 p-3">
        <h3 class="text-xs font-semibold">Callable now</h3>
        <div class="flex flex-wrap gap-1">
          <span
            v-for="tool in snapshot.tools"
            :key="tool"
            class="badge badge-outline badge-sm font-mono"
            >toolbox__{{ tool }}</span
          >
        </div>
        <p class="text-[11px] opacity-60">
          The chat sees these in its tool list from the next message on — no console restart.
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { api } from './api';
import ChatPanel from './components/ChatPanel.vue';
import CreateScriptModal from './components/CreateScriptModal.vue';
import ScriptDetail from './components/ScriptDetail.vue';
import ScriptsPanel from './components/ScriptsPanel.vue';
import ToolConsole from './components/ToolConsole.vue';
import type {
  Health,
  ScriptDetail as ScriptDetailType,
  ScriptRecord,
  ScriptStats,
  ToolDefinition,
} from './types';

type Tab = 'chat' | 'scripts';
const tab = ref<Tab>('chat');

const scripts = ref<ScriptRecord[]>([]);
const stats = ref<ScriptStats | null>(null);
const systemPrompt = ref('');
const tools = ref<ToolDefinition[]>([]);
const health = ref<Health | null>(null);

const selectedName = ref<string | null>(null);
const selected = ref<ScriptDetailType | null>(null);
const loading = ref(true);
const createOpen = ref(false);
const toast = ref<{ message: string; tone: 'success' | 'error' } | null>(null);

const allowRun = computed(() => health.value?.allowRun ?? true);

function notify(message: string, tone: 'success' | 'error'): void {
  toast.value = { message, tone };
  window.setTimeout(() => (toast.value = null), 3200);
}

async function loadScripts(options: { keepSelection?: boolean } = {}): Promise<void> {
  loading.value = true;
  try {
    const response = await api.listScripts();
    scripts.value = response.scripts;
    stats.value = response.stats;
    systemPrompt.value = response.systemPrompt;

    const stillThere =
      selectedName.value &&
      response.scripts.some((record) => record.meta.name === selectedName.value);
    if (!options.keepSelection || !stillThere) {
      selectedName.value = response.scripts[0]?.meta.name ?? null;
    }
    await loadSelected();
  } catch (error) {
    notify((error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

async function loadSelected(): Promise<void> {
  if (!selectedName.value) {
    selected.value = null;
    return;
  }
  try {
    const response = await api.getScript(selectedName.value);
    selected.value = response.script;
  } catch {
    selected.value = null;
  }
}

async function select(name: string): Promise<void> {
  selectedName.value = name;
  await loadSelected();
}

async function removeScript(name: string): Promise<void> {
  try {
    await api.removeScript(name);
    notify(`Removed ${name}`, 'success');
    if (selectedName.value === name) selectedName.value = null;
    await loadScripts();
  } catch (error) {
    notify((error as Error).message, 'error');
  }
}

async function onCreated(name: string): Promise<void> {
  selectedName.value = name;
  await loadScripts({ keepSelection: true });
}

onMounted(async () => {
  try {
    health.value = await api.health();
    tools.value = (await api.tools()).tools;
  } catch (error) {
    notify((error as Error).message, 'error');
  }
  await loadScripts();
});
</script>

<template>
  <div class="grid-lines min-h-screen bg-base-100 text-base-content">
    <header class="sticky top-0 z-20 border-b border-base-300 bg-base-100/85 backdrop-blur">
      <div class="navbar mx-auto max-w-7xl gap-2 px-3">
        <div class="flex flex-1 items-center gap-3">
          <span class="grid h-9 w-9 place-items-center rounded-xl bg-primary/20 text-lg">⚡</span>
          <div>
            <p class="text-sm font-semibold leading-tight">InfAgent</p>
            <p class="text-[11px] leading-tight opacity-60">agent script console</p>
          </div>
        </div>

        <div class="hidden items-center gap-2 sm:flex">
          <span v-if="health" class="badge badge-ghost badge-sm font-mono">{{
            health.version
          }}</span>
          <span v-if="health" class="badge badge-ghost badge-sm font-mono"
            >node {{ health.node }}</span
          >
          <span class="badge badge-sm" :class="allowRun ? 'badge-success' : 'badge-warning'">
            {{ allowRun ? 'exec enabled' : 'exec disabled' }}
          </span>
        </div>

        <button
          class="btn btn-ghost btn-sm btn-circle"
          title="Reload"
          @click="loadScripts({ keepSelection: true })"
        >
          ⟳
        </button>
      </div>
    </header>

    <main
      v-if="tab === 'scripts'"
      class="mx-auto grid max-w-7xl gap-4 p-3 sm:p-4 lg:grid-cols-[22rem_1fr]"
    >
      <ScriptsPanel
        :scripts="scripts"
        :stats="stats"
        :selected="selectedName"
        :loading="loading"
        @select="select"
        @create="createOpen = true"
        @remove="removeScript"
      />

      <div class="min-w-0 space-y-4">
        <ScriptDetail
          :script="selected"
          :allow-run="allowRun"
          @notify="notify"
          @changed="loadScripts({ keepSelection: true })"
        />
        <ToolConsole
          :tools="tools"
          :system-prompt="systemPrompt"
          @notify="notify"
          @changed="loadScripts({ keepSelection: true })"
        />
      </div>
    </main>

    <main v-else class="mx-auto max-w-7xl p-3 sm:p-4">
      <ChatPanel @notify="notify" />
    </main>

    <footer
      v-if="tab === 'scripts' && stats"
      class="mx-auto max-w-7xl px-4 pb-8 text-center text-[11px] opacity-50"
    >
      {{ stats.count }} scripts · {{ stats.byLanguage.js }} js · {{ stats.byLanguage.py }} py ·
      folder {{ stats.root }}
    </footer>

    <CreateScriptModal v-model:open="createOpen" @created="onCreated" @notify="notify" />

    <div v-if="toast" class="toast toast-end z-30">
      <div
        class="alert py-2 text-sm"
        :class="toast.tone === 'success' ? 'alert-success' : 'alert-error'"
      >
        <span>{{ toast.message }}</span>
      </div>
    </div>
  </div>
</template>

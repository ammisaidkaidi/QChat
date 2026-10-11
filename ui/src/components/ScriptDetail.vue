<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { api, copyText } from '../api';
import type { ScriptDetail, ScriptRunResult } from '../types';

const props = defineProps<{
  script: ScriptDetail | null;
  allowRun: boolean;
}>();

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
  (event: 'changed'): void;
}>();

type Tab = 'overview' | 'prompt' | 'source' | 'run';

const tab = ref<Tab>('overview');
const promptText = ref('');
const copied = ref(false);
const argsText = ref('{}');
const running = ref(false);
const runResult = ref<ScriptRunResult | null>(null);
const argsError = ref('');

watch(
  () => props.script?.meta.name,
  async (name) => {
    runResult.value = null;
    tab.value = 'overview';
    argsError.value = '';
    if (!name) return;

    const example: Record<string, unknown> = {};
    for (const param of props.script?.meta.params ?? [])
      if (param.required) example[param.name] = '';
    argsText.value = JSON.stringify(example, null, 2);

    try {
      const response = await api.getPrompt(name);
      promptText.value = response.prompt;
    } catch (error) {
      promptText.value = `Could not load the prompt: ${(error as Error).message}`;
    }
  },
  { immediate: true },
);

const paramCount = computed(() => props.script?.meta.params.length ?? 0);

async function copy(value: string, label: string): Promise<void> {
  const ok = await copyText(value);
  if (ok && label === 'Prompt') {
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  }
  emit(
    'notify',
    ok ? `${label} copied` : 'Clipboard blocked — select the text manually',
    ok ? 'success' : 'error',
  );
}

function prettify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function run(): Promise<void> {
  if (!props.script) return;
  argsError.value = '';

  let parsed: Record<string, unknown> = {};
  const raw = argsText.value.trim();
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('must be an object');
      parsed = value as Record<string, unknown>;
    } catch (error) {
      argsError.value = `Arguments must be a JSON object: ${(error as Error).message}`;
      return;
    }
  }

  running.value = true;
  try {
    const response = await api.runScript(props.script.meta.name, parsed);
    runResult.value = response.result;
    emit(
      'notify',
      response.result.ok ? 'Script finished' : 'Script failed — check stderr',
      response.result.ok ? 'success' : 'error',
    );
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    running.value = false;
  }
}

async function remove(): Promise<void> {
  if (!props.script) return;
  try {
    await api.removeScript(props.script.meta.name);
    emit('notify', `Removed ${props.script.meta.name}`, 'success');
    emit('changed');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}
</script>

<template>
  <section v-if="!script" class="card border border-base-300 bg-base-200/70">
    <div class="card-body items-center py-16 text-center">
      <div class="grid h-14 w-14 place-items-center rounded-2xl bg-primary/15 text-2xl">🧠</div>
      <h2 class="card-title">Agent script console</h2>
      <p class="max-w-md text-sm opacity-70">
        Every script in the folder is self-describing: its header tells the agent when to call it
        and what it returns. Pick one on the left, or create a new callback.
      </p>
    </div>
  </section>

  <section v-else class="card border border-base-300 bg-base-200/70">
    <div class="card-body gap-4 p-4 sm:p-5">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span
              class="badge"
              :class="script.meta.language === 'js' ? 'badge-warning' : 'badge-info'"
            >
              {{ script.meta.language === 'js' ? 'JavaScript' : 'Python' }}
            </span>
            <span class="badge badge-ghost badge-sm font-mono">{{ script.meta.version }}</span>
          </div>
          <h2 class="mt-2 font-mono text-xl font-semibold">{{ script.meta.name }}</h2>
          <p class="mt-1 max-w-2xl text-sm opacity-75">
            {{ script.meta.description || 'No description' }}
          </p>
        </div>
        <button class="btn btn-ghost btn-sm text-error" @click="remove">Remove</button>
      </header>

      <div class="grid gap-2 text-xs sm:grid-cols-3">
        <div class="rounded-box bg-base-300/40 p-3">
          <p class="opacity-60">Callback</p>
          <p class="mt-1 font-mono break-all">{{ script.meta.callback }}</p>
        </div>
        <div class="rounded-box bg-base-300/40 p-3">
          <p class="opacity-60">Arguments</p>
          <p class="mt-1 font-mono">
            {{ paramCount === 0 ? 'none' : script.meta.params.map((p) => p.name).join(', ') }}
          </p>
        </div>
        <div class="rounded-box bg-base-300/40 p-3">
          <p class="opacity-60">File</p>
          <p class="mt-1 font-mono break-all">{{ script.relativePath }}</p>
        </div>
      </div>

      <div role="tablist" class="tabs tabs-boxed tabs-sm">
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'overview' }"
          @click="tab = 'overview'"
        >
          Overview
        </button>
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'prompt' }"
          @click="tab = 'prompt'"
        >
          Agent prompt
        </button>
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'source' }"
          @click="tab = 'source'"
        >
          Source
        </button>
        <button
          role="tab"
          class="tab"
          :class="{ 'tab-active': tab === 'run' }"
          @click="tab = 'run'"
        >
          Run
        </button>
      </div>

      <div v-if="tab === 'overview'" class="space-y-3">
        <div v-if="paramCount > 0" class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th>Argument</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="param in script.meta.params" :key="param.name">
                <td class="font-mono">{{ param.name }}</td>
                <td>{{ param.type }}</td>
                <td>
                  <span
                    class="badge badge-xs"
                    :class="param.required ? 'badge-error' : 'badge-ghost'"
                  >
                    {{ param.required ? 'yes' : 'no' }}
                  </span>
                </td>
                <td class="opacity-75">{{ param.description || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rounded-box bg-base-300/40 p-3 text-sm">
          <p class="mb-1 text-xs opacity-60">Shell usage</p>
          <code class="font-mono text-xs break-all">{{ script.meta.usage }}</code>
        </div>
      </div>

      <div v-else-if="tab === 'prompt'" class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-xs opacity-60">
            Ready to paste into an agent's tool description or system prompt.
          </p>
          <button class="btn btn-xs btn-outline" @click="copy(promptText, 'Prompt')">
            {{ copied ? 'Copied' : 'Copy' }}
          </button>
        </div>
        <pre
          class="max-h-96 overflow-auto rounded-box bg-base-300/50 p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
          >{{ promptText }}</pre>
      </div>

      <div v-else-if="tab === 'source'" class="space-y-2">
        <div class="flex items-center justify-between">
          <p class="text-xs opacity-60">{{ script.bytes }} bytes · header included</p>
          <button class="btn btn-xs btn-outline" @click="copy(script.source, 'Source')">
            Copy
          </button>
        </div>
        <pre
          class="max-h-96 overflow-auto rounded-box bg-neutral p-4 font-mono text-[11px] leading-relaxed text-neutral-content"
          >{{ script.source }}</pre>
      </div>

      <div v-else class="space-y-3">
        <div class="alert alert-warning py-2 text-xs" v-if="!allowRun && script">
          Execution is disabled (INFAGENT_ALLOW_RUN=0).
        </div>
        <label class="form-control">
          <span class="mb-1 text-xs opacity-60">Arguments (JSON object)</span>
          <textarea
            v-model="argsText"
            rows="5"
            class="textarea textarea-bordered w-full font-mono text-xs"
          ></textarea>
        </label>
        <p v-if="argsError" class="text-xs text-error">{{ argsError }}</p>
        <div class="flex items-center gap-2">
          <button class="btn btn-primary btn-sm" :disabled="running || !allowRun" @click="run">
            <span v-if="running" class="loading loading-spinner loading-xs" />
            {{ running ? 'Running' : 'Run script' }}
          </button>
          <span v-if="runResult" class="text-xs opacity-70">
            exit {{ runResult.exitCode ?? 'null' }} · {{ runResult.durationMs }}ms
          </span>
        </div>

        <div v-if="runResult" class="space-y-2">
          <div class="rounded-box bg-base-300/40 p-3">
            <p class="mb-1 text-xs opacity-60">Command</p>
            <code class="font-mono text-xs break-all">{{ runResult.command }}</code>
          </div>
          <div v-if="runResult.envelope !== undefined" class="rounded-box bg-base-300/40 p-3">
            <p class="mb-1 text-xs opacity-60">Result envelope</p>
            <pre class="font-mono text-[11px] whitespace-pre-wrap">{{
              prettify(runResult.envelope)
            }}</pre>
          </div>
          <div v-if="runResult.stdout.trim()" class="rounded-box bg-neutral p-3">
            <p class="mb-1 text-xs opacity-60">stdout</p>
            <pre class="font-mono text-[11px] whitespace-pre-wrap text-neutral-content">{{
              runResult.stdout
            }}</pre>
          </div>
          <div v-if="runResult.stderr.trim()" class="rounded-box bg-error/15 p-3">
            <p class="mb-1 text-xs text-error">stderr</p>
            <pre class="font-mono text-[11px] whitespace-pre-wrap">{{ runResult.stderr }}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

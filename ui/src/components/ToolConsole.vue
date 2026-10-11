<script setup lang="ts">
import { computed, ref } from 'vue';

import { api, copyText } from '../api';
import type { CreateScriptInput, ToolDefinition } from '../types';

const props = defineProps<{
  tools: ToolDefinition[];
  systemPrompt: string;
}>();

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
  (event: 'changed'): void;
}>();

interface CallLog {
  id: number;
  tool: string;
  args: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

const selected = ref<string>('');
const argsText = ref('{}');
const busy = ref(false);
const log = ref<CallLog[]>([]);
const showPrompt = ref(false);
let counter = 0;

const current = computed(() => props.tools.find((tool) => tool.name === selected.value) ?? null);

function select(name: string): void {
  selected.value = name;
  const tool = props.tools.find((item) => item.name === name);
  const template: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool?.parameters.properties ?? {})) {
    template[key] = schema.type === 'array' ? [] : schema.type === 'object' ? {} : '';
  }
  argsText.value = JSON.stringify(template, null, 2);
}

/** Runs exactly what an agent's tool-call loop would run. */
async function invoke(): Promise<void> {
  if (!current.value) return;

  let args: Record<string, unknown> = {};
  const raw = argsText.value.trim();
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('must be an object');
      args = parsed as Record<string, unknown>;
    } catch (error) {
      emit('notify', `Arguments must be a JSON object: ${(error as Error).message}`, 'error');
      return;
    }
  }

  busy.value = true;
  const startedAt = Date.now();
  const entry: CallLog = {
    id: (counter += 1),
    tool: current.value.name,
    args: JSON.stringify(args),
    ok: true,
    output: '',
    durationMs: 0,
  };

  try {
    entry.output = JSON.stringify(await callTool(current.value.name, args), null, 2);
    entry.ok = true;
  } catch (error) {
    entry.ok = false;
    entry.output = (error as Error).message;
  } finally {
    entry.durationMs = Date.now() - startedAt;
    busy.value = false;
  }

  log.value.unshift(entry);
  log.value = log.value.slice(0, 12);
  emit('notify', `${entry.tool} ${entry.ok ? 'ok' : 'failed'}`, entry.ok ? 'success' : 'error');
  if (entry.ok && ['createScript', 'updateScript', 'removeScript'].includes(entry.tool))
    emit('changed');
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'listScripts':
      return await api.listScripts();
    case 'searchScripts':
      return await api.listScripts().then((response) => ({
        scripts: response.scripts.filter((record) =>
          [record.meta.name, record.meta.description, record.meta.agentPrompt]
            .join(' ')
            .toLowerCase()
            .includes(String(args['query'] ?? '').toLowerCase()),
        ),
      }));
    case 'readScript':
      return await api.getScript(String(args['name'] ?? ''));
    case 'describeScript':
      return (await api.getScript(String(args['name'] ?? ''))).script.meta;
    case 'createScript':
      return await api.createScript(args as unknown as CreateScriptInput);
    case 'removeScript':
      return await api.removeScript(String(args['name'] ?? ''));
    case 'runScript':
      return await api.runScript(
        String(args['name'] ?? ''),
        (args['args'] as Record<string, unknown>) ?? {},
      );
    case 'scriptStats':
      return (await api.listScripts()).stats;
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

async function copyPrompt(): Promise<void> {
  const ok = await copyText(props.systemPrompt);
  emit('notify', ok ? 'System prompt copied' : 'Clipboard blocked', ok ? 'success' : 'error');
}
</script>

<template>
  <section class="card border border-base-300 bg-base-200/70">
    <div class="card-body gap-4 p-4 sm:p-5">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="card-title text-base">Agent tool console</h2>
          <p class="text-xs opacity-70">
            The built-in callbacks an LLM invokes by name. Executing here mirrors the agent's own
            tool-call loop.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost btn-xs" @click="showPrompt = !showPrompt">
            {{ showPrompt ? 'Hide prompt' : 'System prompt' }}
          </button>
          <button class="btn btn-outline btn-xs" @click="copyPrompt">Copy</button>
        </div>
      </header>

      <pre
        v-if="showPrompt"
        class="max-h-72 overflow-auto rounded-box bg-base-300/50 p-4 font-mono text-[11px] whitespace-pre-wrap"
        >{{ systemPrompt }}</pre>

      <div class="flex flex-wrap gap-2">
        <button
          v-for="tool in tools"
          :key="tool.name"
          class="btn btn-xs"
          :class="selected === tool.name ? 'btn-primary' : 'btn-ghost border border-base-300'"
          @click="select(tool.name)"
        >
          <span class="font-mono">{{ tool.name }}</span>
        </button>
      </div>

      <div v-if="current" class="grid gap-3 lg:grid-cols-2">
        <div class="space-y-2">
          <p class="text-xs opacity-70">{{ current.description }}</p>
          <label class="form-control">
            <span class="mb-1 text-xs opacity-60">Arguments (JSON)</span>
            <textarea
              v-model="argsText"
              rows="7"
              class="textarea textarea-bordered w-full font-mono text-xs"
            ></textarea>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="busy" @click="invoke">
            <span v-if="busy" class="loading loading-spinner loading-xs" />
            Invoke {{ current.name }}
          </button>
        </div>

        <div class="space-y-2">
          <p class="text-xs opacity-60">Call log</p>
          <p v-if="log.length === 0" class="rounded-box bg-base-300/40 p-4 text-xs opacity-60">
            No calls yet. Pick a callback, hit invoke, and the JSON result appears here.
          </p>
          <div
            v-for="entry in log"
            :key="entry.id"
            class="rounded-box border border-base-300 bg-base-300/30 p-3"
          >
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="font-mono"
                >{{ entry.tool }}({{
                  entry.args.length > 40 ? `${entry.args.slice(0, 40)}…` : entry.args
                }})</span
              >
              <span class="badge badge-xs" :class="entry.ok ? 'badge-success' : 'badge-error'">
                {{ entry.ok ? 'ok' : 'error' }} · {{ entry.durationMs }}ms
              </span>
            </div>
            <pre
              class="mt-2 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap opacity-80"
              >{{ entry.output }}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

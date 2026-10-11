<script setup lang="ts">
/**
 * MCP tab: servers declared in `mcp.json` and the tools they expose.
 *
 * Servers are managed by `src/mcp/manager.ts`; every tool is addressable both
 * from here (the Try-it console) and by the chat model as `server__tool`.
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { mcpApi } from '../api';
import type { McpCatalogue } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const catalogue = ref<McpCatalogue | null>(null);
const busy = ref<string | null>(null);
const showAdd = ref(false);
const selectedTool = ref<string>('');
const argsText = ref('{}');
const running = ref(false);
const result = ref<{ ok: boolean; text: string; durationMs: number } | null>(null);

const newServer = reactive({ name: '', command: 'npx', args: '', description: '' });

const tools = computed(() => catalogue.value?.tools ?? []);

async function load(): Promise<void> {
  try {
    catalogue.value = await mcpApi.list();
    if (!selectedTool.value && tools.value.length > 0) {
      selectedTool.value = tools.value[0]!.qualified;
    }
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function start(name: string): Promise<void> {
  busy.value = name;
  try {
    await mcpApi.start(name);
    emit('notify', `MCP server ${name} connected`, 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = null;
    await load();
  }
}

async function stop(name: string): Promise<void> {
  busy.value = name;
  try {
    await mcpApi.stop(name);
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = null;
    await load();
  }
}

async function remove(name: string): Promise<void> {
  if (!window.confirm(`Remove the MCP server "${name}" from mcp.json?`)) return;
  try {
    catalogue.value = await mcpApi.remove(name);
    emit('notify', `Removed ${name}`, 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function add(): Promise<void> {
  try {
    catalogue.value = await mcpApi.add({
      name: newServer.name.trim(),
      command: newServer.command.trim(),
      args: newServer.args.trim() ? newServer.args.trim().split(/\s+/) : [],
      ...(newServer.description.trim() ? { description: newServer.description.trim() } : {}),
    });
    emit('notify', `Server ${newServer.name} added`, 'success');
    showAdd.value = false;
    newServer.name = '';
    newServer.args = '';
    newServer.description = '';
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function call(): Promise<void> {
  running.value = true;
  result.value = null;
  try {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(argsText.value || '{}') as Record<string, unknown>;
    } catch {
      throw new Error('Arguments must be valid JSON.');
    }
    const response = await mcpApi.call(selectedTool.value, parsed);
    result.value = { ok: response.ok, text: response.text, durationMs: response.durationMs };
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    running.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="grid gap-4">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-semibold">MCP servers</h2>
            <p class="font-mono text-[11px] opacity-60">
              {{ catalogue?.configPath ?? 'mcp.json' }} · {{ tools.length }} tool(s) available
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn btn-ghost btn-xs" @click="load">⟳ Refresh</button>
            <button class="btn btn-primary btn-xs" @click="showAdd = !showAdd">
              {{ showAdd ? 'Close' : 'Add server' }}
            </button>
          </div>
        </header>

        <div v-if="showAdd" class="grid gap-2 rounded-box border border-base-300 p-3 sm:grid-cols-2">
          <input v-model="newServer.name" class="input input-bordered input-xs font-mono" placeholder="name (e.g. filesystem)" />
          <input v-model="newServer.command" class="input input-bordered input-xs font-mono" placeholder="command (node, npx, python…)" />
          <input v-model="newServer.args" class="input input-bordered input-xs font-mono sm:col-span-2" placeholder="args, space separated (mcp/example-server.mjs)" />
          <input v-model="newServer.description" class="input input-bordered input-xs sm:col-span-2" placeholder="what it is for (optional)" />
          <div class="sm:col-span-2">
            <button class="btn btn-primary btn-xs" :disabled="!newServer.name || !newServer.command" @click="add">
              Save &amp; connect
            </button>
          </div>
        </div>

        <p v-if="!catalogue || catalogue.servers.length === 0" class="py-6 text-center text-xs opacity-60">
          No servers configured yet. Add one above — for example
          <code class="font-mono">npx -y @modelcontextprotocol/server-filesystem .</code>
        </p>

        <article
          v-for="server in catalogue?.servers ?? []"
          :key="server.name"
          class="rounded-box border border-base-300 p-3"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="flex items-center gap-2 text-sm">
                <span class="font-mono">{{ server.name }}</span>
                <span
                  class="badge badge-sm"
                  :class="{
                    'badge-success': server.state === 'ready',
                    'badge-warning': server.state === 'starting',
                    'badge-error': server.state === 'error',
                    'badge-ghost': server.state === 'stopped',
                  }"
                >
                  {{ server.state }}
                </span>
                <span v-if="server.serverInfo.name" class="badge badge-ghost badge-sm font-mono">
                  {{ server.serverInfo.name }} {{ server.serverInfo.version }}
                </span>
              </p>
              <p class="truncate text-[11px] opacity-70">
                {{ server.description || `${server.command} ${server.args.join(' ')}` }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="server.state !== 'ready'"
                class="btn btn-xs btn-primary"
                :disabled="busy === server.name"
                @click="start(server.name)"
              >
                <span v-if="busy === server.name" class="loading loading-spinner loading-xs" />
                Connect
              </button>
              <button
                v-else
                class="btn btn-xs btn-ghost"
                :disabled="busy === server.name"
                @click="stop(server.name)"
              >
                Disconnect
              </button>
              <button class="btn btn-xs btn-ghost text-error" @click="remove(server.name)">
                Remove
              </button>
            </div>
          </div>

          <p v-if="server.lastError" class="mt-2 rounded bg-error/10 p-2 text-[11px] text-error">
            {{ server.lastError }}
          </p>

          <ul v-if="server.tools.length > 0" class="mt-2 grid gap-1">
            <li v-for="tool in server.tools" :key="tool.name" class="text-[11px] opacity-80">
              <span class="font-mono">{{ server.name }}__{{ tool.name }}</span>
              — {{ tool.description }}
            </li>
          </ul>
          <p v-else class="mt-2 text-[11px] opacity-50">No tools listed.</p>
        </article>
      </div>
    </section>

    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <h2 class="text-sm font-semibold">Try a tool</h2>
        <div class="flex flex-wrap items-end gap-2">
          <select v-model="selectedTool" class="select select-bordered select-sm font-mono">
            <option v-for="tool in tools" :key="tool.qualified" :value="tool.qualified">
              {{ tool.qualified }}
            </option>
          </select>
          <input
            v-model="argsText"
            class="input input-bordered input-sm flex-1 font-mono"
            placeholder='{"text": "hello"}'
          />
          <button
            class="btn btn-primary btn-sm"
            :disabled="running || !selectedTool"
            @click="call"
          >
            <span v-if="running" class="loading loading-spinner loading-xs" />
            Call
          </button>
        </div>

        <div v-if="result" class="rounded-box bg-base-300/40 p-3">
          <p class="mb-1 text-[11px] opacity-70">
            {{ result.ok ? '✔ ok' : '✘ failed' }} · {{ result.durationMs }}ms
          </p>
          <pre class="max-h-56 overflow-auto text-xs whitespace-pre-wrap">{{ result.text }}</pre>
        </div>
        <p v-else class="text-[11px] opacity-60">
          Tool calls from here use the same dispatcher the chat model uses.
        </p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type { ScriptRecord, ScriptStats, ScriptLanguage } from '../types';

const props = defineProps<{
  scripts: ScriptRecord[];
  stats: ScriptStats | null;
  selected: string | null;
  loading: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', name: string): void;
  (event: 'create'): void;
  (event: 'remove', name: string): void;
}>();

const query = ref('');
const language = ref<'all' | ScriptLanguage>('all');

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return props.scripts.filter((record) => {
    const matchesLanguage = language.value === 'all' || record.meta.language === language.value;
    if (!matchesLanguage) return false;
    if (!needle) return true;
    return [record.meta.name, record.meta.description, record.meta.agentPrompt]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
});

function initials(record: ScriptRecord): string {
  return record.meta.language === 'js' ? 'JS' : 'PY';
}
</script>

<template>
  <aside class="card border border-base-300 bg-base-200/70 shadow-sm">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center justify-between gap-2">
        <h2 class="card-title text-base">
          Scripts
          <span class="badge badge-sm badge-ghost">{{ scripts.length }}</span>
        </h2>
        <button class="btn btn-primary btn-sm" @click="emit('create')">
          <span class="text-lg leading-none">+</span> New
        </button>
      </div>

      <label class="input input-sm input-bordered flex items-center gap-2">
        <svg
          class="h-4 w-4 opacity-50"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" stroke-linecap="round" />
        </svg>
        <input
          v-model="query"
          type="search"
          class="grow"
          placeholder="Search name, description, prompt"
        />
      </label>

      <div role="tablist" class="tabs tabs-boxed tabs-sm w-full">
        <button
          role="tab"
          class="tab flex-1"
          :class="{ 'tab-active': language === 'all' }"
          @click="language = 'all'"
        >
          All
        </button>
        <button
          role="tab"
          class="tab flex-1"
          :class="{ 'tab-active': language === 'js' }"
          @click="language = 'js'"
        >
          .js<span class="ml-1 opacity-60">{{ stats?.byLanguage.js ?? 0 }}</span>
        </button>
        <button
          role="tab"
          class="tab flex-1"
          :class="{ 'tab-active': language === 'py' }"
          @click="language = 'py'"
        >
          .py<span class="ml-1 opacity-60">{{ stats?.byLanguage.py ?? 0 }}</span>
        </button>
      </div>

      <div v-if="loading" class="flex flex-col gap-2">
        <div v-for="index in 3" :key="index" class="skeleton h-16 w-full" />
      </div>

      <p
        v-else-if="filtered.length === 0"
        class="rounded-box bg-base-300/40 p-4 text-sm opacity-70"
      >
        No script matches. Create one to get started.
      </p>

      <ul v-else class="menu max-h-[26rem] w-full flex-nowrap gap-1 overflow-y-auto p-0">
        <li v-for="record in filtered" :key="record.meta.name">
          <div
            class="flex items-start gap-3 rounded-field p-3"
            :class="{ 'bg-primary/15 ring-1 ring-primary/40': record.meta.name === selected }"
          >
            <button class="flex-1 text-left" @click="emit('select', record.meta.name)">
              <div class="flex items-center gap-2">
                <span
                  class="badge badge-xs"
                  :class="record.meta.language === 'js' ? 'badge-warning' : 'badge-info'"
                  >{{ initials(record) }}</span
                >
                <span class="font-mono text-sm font-semibold">{{ record.meta.name }}</span>
              </div>
              <p class="mt-1 line-clamp-2 text-xs opacity-70">
                {{ record.meta.description || 'No description' }}
              </p>
            </button>
            <button
              class="btn btn-ghost btn-xs text-error"
              title="Remove script"
              @click.stop="emit('remove', record.meta.name)"
            >
              ✕
            </button>
          </div>
        </li>
      </ul>

      <p v-if="stats" class="text-center text-[11px] opacity-50">
        {{ stats.count }} scripts · {{ (stats.totalBytes / 1024).toFixed(1) }} KB · {{ stats.root }}
      </p>
    </div>
  </aside>
</template>

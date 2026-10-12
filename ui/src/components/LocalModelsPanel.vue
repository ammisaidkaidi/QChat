<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { chatApi } from '../api';
import type { EngineStatus, ModelCatalog, ModelRecord } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const catalog = ref<ModelCatalog | null>(null);
const status = ref<EngineStatus | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const switchingId = ref('');
const downloadingId = ref('');
const query = ref('');
const loadError = ref('');

const defaultModel = computed(
  () =>
    catalog.value?.models.find((model) => model.settings.id === catalog.value?.defaultActive) ??
    null,
);
const downloadedCount = computed(
  () => catalog.value?.models.filter((model) => model.present).length ?? 0,
);
const modelOperationBusy = computed(
  () => Boolean(downloadingId.value || switchingId.value) || status.value?.state === 'downloading',
);
const filteredModels = computed(() => {
  const models = catalog.value?.models ?? [];
  const search = query.value.trim().toLowerCase();
  if (!search) return models;
  return models.filter((model) =>
    [model.settings.id, model.settings.name, model.settings.description, model.settings.family]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(search),
  );
});

function formatBytes(bytes: number): string {
  if (bytes <= 0) return 'size unknown';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function weightSize(model: ModelRecord): number {
  return model.bytesOnDisk || model.sizeBytes || model.settings.sizeBytes || 0;
}

function stateTone(state: EngineStatus['state'] | undefined): string {
  if (state === 'ready') return 'badge-success';
  if (state === 'loading' || state === 'downloading') return 'badge-info';
  if (state === 'absent' || state === 'unavailable' || state === 'error') return 'badge-warning';
  return 'badge-ghost';
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const [models, engine] = await Promise.all([chatApi.models(), chatApi.status()]);
    catalog.value = models;
    status.value = engine.status;
  } catch (error) {
    loadError.value = (error as Error).message;
    emit('notify', `Local models could not be loaded: ${loadError.value}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function refreshCatalogue(): Promise<void> {
  refreshing.value = true;
  try {
    catalog.value = await chatApi.refreshModels();
    const engine = await chatApi.status();
    status.value = engine.status;
    emit('notify', 'Local model catalogue refreshed.', 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    refreshing.value = false;
  }
}

async function setDefault(model: ModelRecord): Promise<void> {
  switchingId.value = model.settings.id;
  try {
    const result = await chatApi.useModel(model.settings.id, true);
    catalog.value = result;
    status.value = result.status;
    emit(
      'notify',
      `${model.settings.name} is now the default for new chats. Existing chats keep their own model.`,
      'success',
    );
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    switchingId.value = '';
  }
}

function download(model: ModelRecord): void {
  downloadingId.value = model.settings.id;
  chatApi.download(
    (_progress, nextStatus) => {
      status.value = nextStatus;
    },
    (nextStatus) => {
      status.value = nextStatus;
      downloadingId.value = '';
      emit('notify', `${model.settings.name} downloaded.`, 'success');
      void load();
    },
    (message) => {
      downloadingId.value = '';
      emit('notify', message, 'error');
      void load();
    },
    model.settings.id,
  );
}

async function unload(): Promise<void> {
  try {
    const result = await chatApi.unload();
    status.value = result.status;
    emit('notify', 'Local model unloaded from memory.', 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

onMounted(load);
</script>

<template>
  <section class="card border border-base-300 bg-base-200/70" data-testid="local-models-panel">
    <div class="card-body gap-4 p-3 sm:p-4">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-sm font-semibold">💻 Local models</h2>
          <p class="text-[11px] opacity-65">
            Download and inspect local weights, set the default for new chats, or unload the model
            from memory. Existing chats keep their per-chat model choice.
          </p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-xs" :disabled="loading || refreshing" @click="load">
            Reload
          </button>
          <button
            class="btn btn-ghost btn-xs"
            :disabled="loading || refreshing || modelOperationBusy"
            data-testid="refresh-local-models"
            @click="refreshCatalogue"
          >
            <span v-if="refreshing" class="loading loading-spinner loading-xs" />
            Refresh catalogue
          </button>
        </div>
      </header>

      <div class="grid gap-2 sm:grid-cols-3">
        <div class="stat rounded-box bg-base-100 p-3">
          <div class="stat-title text-[10px]">Catalogue</div>
          <div class="stat-value text-lg">{{ catalog?.models.length ?? '—' }}</div>
          <div class="stat-desc text-[10px]">{{ downloadedCount }} downloaded</div>
        </div>
        <div class="stat rounded-box bg-base-100 p-3">
          <div class="stat-title text-[10px]">Default for new chats</div>
          <div class="stat-value truncate text-sm">
            {{ defaultModel?.settings.name ?? 'Not set' }}
          </div>
          <div class="stat-desc truncate font-mono text-[10px]">
            {{ catalog?.defaultActive ?? '—' }}
          </div>
        </div>
        <div class="stat rounded-box bg-base-100 p-3">
          <div class="stat-title text-[10px]">Local engine</div>
          <div class="flex items-center gap-2">
            <span class="badge badge-sm" :class="stateTone(status?.state)">
              {{ status?.state ?? 'unknown' }}
            </span>
            <span class="truncate font-mono text-[10px]">{{
              catalog?.active || status?.modelId || '—'
            }}</span>
          </div>
          <div class="stat-desc truncate text-[10px]">
            {{
              status?.state === 'ready'
                ? 'Loaded in memory'
                : status?.modelPresent
                  ? 'Weights available'
                  : 'Weights not loaded'
            }}
          </div>
        </div>
      </div>

      <div v-if="status?.state === 'downloading'" class="space-y-1 rounded-box bg-base-100 p-3">
        <div class="flex items-center justify-between text-[11px]">
          <span>Downloading {{ downloadingId || status.modelName }}…</span>
          <span class="font-mono">{{ Math.round(status.downloadProgress * 100) }}%</span>
        </div>
        <progress
          class="progress progress-primary w-full"
          :value="status.downloadProgress * 100"
          max="100"
        />
        <p class="text-[10px] opacity-60">
          {{ formatBytes(status.downloadedBytes) }} of
          {{ formatBytes(status.downloadTotalBytes) }} · saved to
          {{ catalog?.weightsDir ?? status.weightsDir }}
        </p>
      </div>

      <div v-if="loadError" class="alert alert-error py-2 text-xs">
        <span>{{ loadError }}</span>
        <button class="btn btn-ghost btn-xs" @click="load">Retry</button>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <label class="input input-bordered input-sm flex min-w-48 flex-1 items-center gap-2">
          <span class="opacity-50">⌕</span>
          <input v-model="query" type="search" class="grow" placeholder="Filter local models" />
        </label>
        <button
          v-if="status?.state === 'ready'"
          class="btn btn-ghost btn-xs"
          :disabled="modelOperationBusy"
          @click="unload"
        >
          Unload from memory
        </button>
      </div>

      <div v-if="loading" class="flex items-center gap-2 py-6 text-xs opacity-60">
        <span class="loading loading-spinner loading-xs" /> Loading local models…
      </div>
      <p
        v-else-if="filteredModels.length === 0"
        class="rounded-box border border-dashed border-base-300 p-5 text-center text-xs opacity-60"
      >
        {{
          catalog?.models.length
            ? 'No local models match this filter.'
            : 'No models are in the local catalogue.'
        }}
      </p>

      <div v-else class="grid gap-2 lg:grid-cols-2">
        <article
          v-for="model in filteredModels"
          :key="model.settings.id"
          class="rounded-box border border-base-300 bg-base-100 p-3"
          :data-testid="`local-model-${model.settings.id}`"
        >
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <h3 class="text-xs font-semibold">{{ model.settings.name }}</h3>
              <p class="break-all font-mono text-[10px] opacity-60">{{ model.settings.id }}</p>
            </div>
            <span class="badge badge-sm" :class="model.present ? 'badge-success' : 'badge-ghost'">
              {{
                model.present ? `Downloaded · ${formatBytes(weightSize(model))}` : 'Not downloaded'
              }}
            </span>
          </div>
          <p v-if="model.settings.description" class="mt-2 text-[11px] opacity-70">
            {{ model.settings.description }}
          </p>
          <div class="mt-2 flex flex-wrap gap-1 text-[10px] opacity-65">
            <span v-if="model.settings.family" class="badge badge-ghost badge-xs">{{
              model.settings.family
            }}</span>
            <span v-if="model.settings.quantization" class="badge badge-ghost badge-xs">{{
              model.settings.quantization
            }}</span>
            <span v-if="model.settings.contextSize" class="badge badge-ghost badge-xs"
              >ctx {{ model.settings.contextSize }}</span
            >
            <span v-if="model.settings.threads" class="badge badge-ghost badge-xs"
              >{{ model.settings.threads }} threads</span
            >
            <span v-if="model.settings.source?.repo" class="badge badge-ghost badge-xs">{{
              model.settings.source.repo
            }}</span>
            <span
              v-if="catalog?.defaultActive === model.settings.id"
              class="badge badge-primary badge-xs"
              >new-chat default</span
            >
            <span v-if="catalog?.active === model.settings.id" class="badge badge-info badge-xs"
              >engine selection</span
            >
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-if="!model.present"
              class="btn btn-primary btn-xs"
              :disabled="modelOperationBusy"
              :data-testid="`download-local-${model.settings.id}`"
              @click="download(model)"
            >
              <span
                v-if="downloadingId === model.settings.id"
                class="loading loading-spinner loading-xs"
              />
              {{
                downloadingId === model.settings.id
                  ? 'Downloading…'
                  : `Download ${formatBytes(model.sizeBytes)}`
              }}
            </button>
            <button
              class="btn btn-ghost btn-xs"
              :disabled="modelOperationBusy || catalog?.defaultActive === model.settings.id"
              :data-testid="`set-local-default-${model.settings.id}`"
              @click="setDefault(model)"
            >
              <span
                v-if="switchingId === model.settings.id"
                class="loading loading-spinner loading-xs"
              />
              {{
                catalog?.defaultActive === model.settings.id
                  ? 'Default for new chats'
                  : 'Set new-chat default'
              }}
            </button>
          </div>
        </article>
      </div>

      <p class="border-t border-base-300 pt-3 text-[10px] opacity-55">
        Per-chat model selection is in the Chat composer’s 🧠 Model menu. Local weights are stored
        outside the repository at
        <code>{{ catalog?.weightsDir ?? status?.weightsDir ?? '~/.cache/infagent/models' }}</code
        >.
      </p>
    </div>
  </section>
</template>

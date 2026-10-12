<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';

import { cloudProvidersApi } from '../api';
import type { CloudAdapter, CloudModel, CloudProvider, CloudProviderPreset } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const providers = ref<CloudProvider[]>([]);
const presets = ref<CloudProviderPreset[]>([]);
const loading = ref(true);
const saving = ref(false);
const testingId = ref('');
const deletingId = ref('');
const confirmDeleteId = ref('');
const selectedPreset = ref('');
const editingId = ref('');
const keyInput = ref<HTMLInputElement | null>(null);
const form = reactive({
  id: '',
  name: '',
  adapter: 'openai-compatible' as CloudAdapter,
  baseUrl: '',
  modelIds: '',
  apiKey: '',
});

const canSave = computed(
  () =>
    form.id.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    !saving.value,
);

function modelsFromText(value: string): CloudModel[] {
  const unique = new Map<string, CloudModel>();
  for (const id of value
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    unique.set(id, { id, name: id });
  }
  return [...unique.values()];
}

function modelsToText(models: CloudModel[]): string {
  return models.map((model) => model.id).join('\n');
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await cloudProvidersApi.list();
    providers.value = response.providers;
    presets.value = response.presets;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

function resetForm(): void {
  editingId.value = '';
  selectedPreset.value = '';
  form.id = '';
  form.name = '';
  form.adapter = 'openai-compatible';
  form.baseUrl = '';
  form.modelIds = '';
  form.apiKey = '';
}

function applyPreset(): void {
  const preset = presets.value.find((candidate) => candidate.id === selectedPreset.value);
  if (!preset) return;
  const existing = providers.value.find((provider) => provider.id === preset.id);
  form.id = existing?.id ?? preset.id;
  form.name = existing?.name ?? preset.name;
  form.adapter = existing?.adapter ?? preset.adapter;
  form.baseUrl = existing?.baseUrl ?? preset.baseUrl;
  form.modelIds = modelsToText(existing?.models ?? []);
  editingId.value = existing?.id ?? '';
  form.apiKey = '';
  void keyInput.value?.focus();
}

function editProvider(provider: CloudProvider): void {
  editingId.value = provider.id;
  selectedPreset.value = '';
  form.id = provider.id;
  form.name = provider.name;
  form.adapter = provider.adapter;
  form.baseUrl = provider.baseUrl;
  form.modelIds = modelsToText(provider.models);
  form.apiKey = '';
  void keyInput.value?.focus();
}

async function saveProvider(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const provider = await cloudProvidersApi.save({
      id: form.id.trim().toLowerCase(),
      name: form.name.trim(),
      adapter: form.adapter,
      baseUrl: form.baseUrl.trim(),
      models: modelsFromText(form.modelIds),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });
    const index = providers.value.findIndex((item) => item.id === provider.provider.id);
    if (index === -1) providers.value.unshift(provider.provider);
    else providers.value[index] = provider.provider;
    const wasKeyProvided = form.apiKey.trim().length > 0;
    form.apiKey = '';
    editingId.value = provider.provider.id;
    emit(
      'notify',
      wasKeyProvided
        ? `${provider.provider.name} saved; the key is write-only in the local .env file.`
        : `${provider.provider.name} saved.`,
      'success',
    );
    await load();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}

async function testProvider(provider: CloudProvider): Promise<void> {
  if (!provider.keyConfigured) {
    emit('notify', 'Save an API key before testing this provider.', 'error');
    return;
  }
  testingId.value = provider.id;
  try {
    const result = await cloudProvidersApi.test(provider.id);
    const index = providers.value.findIndex((item) => item.id === provider.id);
    if (index !== -1) providers.value[index] = result.provider;
    if (editingId.value === provider.id) form.modelIds = modelsToText(result.models);
    emit(
      'notify',
      result.models.length > 0
        ? `Connected to ${provider.name}; found ${result.models.length} model(s).`
        : `Connected to ${provider.name}; add a model ID manually if the provider does not list models.`,
      'success',
    );
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    testingId.value = '';
  }
}

async function deleteProvider(provider: CloudProvider): Promise<void> {
  if (confirmDeleteId.value !== provider.id) {
    confirmDeleteId.value = provider.id;
    return;
  }
  deletingId.value = provider.id;
  confirmDeleteId.value = '';
  try {
    await cloudProvidersApi.remove(provider.id);
    providers.value = providers.value.filter((item) => item.id !== provider.id);
    if (editingId.value === provider.id) resetForm();
    emit('notify', `${provider.name} and its API key were removed.`, 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    deletingId.value = '';
  }
}

function adapterLabel(adapter: CloudAdapter): string {
  if (adapter === 'anthropic') return 'Anthropic Messages API';
  if (adapter === 'gemini') return 'Google Gemini API';
  return 'OpenAI-compatible Chat Completions';
}

onMounted(load);
</script>

<template>
  <section class="card border border-base-300 bg-base-200/70">
    <div class="card-body gap-4 p-3 sm:p-4">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="text-sm font-semibold">☁ Cloud AI providers</h2>
          <p class="text-[11px] opacity-65">
            Add NVIDIA NIM, OpenAI-compatible APIs, Anthropic or Gemini. Each chat can select one
            without changing your local-model default.
          </p>
        </div>
        <button class="btn btn-ghost btn-xs" :disabled="loading" @click="load">Reload</button>
      </header>

      <div class="alert alert-info py-2 text-xs">
        <span>
          API keys are write-only and stored in the gitignored <code>.env</code> file with
          restrictive permissions. Provider URLs and model IDs are stored in InfAgent's user data
          folder. Cloud chats send their messages to the selected provider; local scripts and MCP
          tools are not executed for cloud models.
        </span>
      </div>

      <div v-if="loading" class="flex items-center gap-2 py-4 text-xs opacity-60">
        <span class="loading loading-spinner loading-xs" /> Loading providers…
      </div>

      <div v-else class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
        <div class="space-y-2">
          <p class="text-xs font-semibold">Configured providers · {{ providers.length }}</p>
          <p
            v-if="providers.length === 0"
            class="rounded-box border border-dashed border-base-300 p-4 text-xs opacity-60"
          >
            No cloud providers yet. Choose a preset or add a custom endpoint.
          </p>
          <article
            v-for="provider in providers"
            :key="provider.id"
            class="rounded-box border border-base-300 bg-base-100 p-3"
            :data-testid="`cloud-provider-${provider.id}`"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <h3 class="text-xs font-semibold">{{ provider.name }}</h3>
                <p class="break-all font-mono text-[10px] opacity-60">{{ provider.baseUrl }}</p>
                <p class="mt-1 text-[10px] opacity-60">
                  {{ adapterLabel(provider.adapter) }} · {{ provider.models.length }} model(s)
                </p>
              </div>
              <span
                class="badge badge-sm"
                :class="provider.keyConfigured ? 'badge-success' : 'badge-warning'"
              >
                {{ provider.keyConfigured ? 'API key set' : 'API key needed' }}
              </span>
            </div>
            <div v-if="provider.models.length" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="model in provider.models.slice(0, 8)"
                :key="model.id"
                class="badge badge-ghost badge-xs font-mono"
              >
                {{ model.id }}
              </span>
              <span v-if="provider.models.length > 8" class="badge badge-ghost badge-xs">
                +{{ provider.models.length - 8 }} more
              </span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <button
                class="btn btn-primary btn-xs"
                :disabled="!provider.keyConfigured || !!testingId"
                :data-testid="`cloud-test-${provider.id}`"
                @click="testProvider(provider)"
              >
                <span v-if="testingId === provider.id" class="loading loading-spinner loading-xs" />
                {{ testingId === provider.id ? 'Testing…' : 'Test connection' }}
              </button>
              <button
                class="btn btn-ghost btn-xs"
                :disabled="!!saving || !!deletingId"
                @click="editProvider(provider)"
              >
                Edit
              </button>
              <button
                class="btn btn-ghost btn-xs text-error"
                :disabled="!!deletingId"
                :data-testid="`cloud-delete-${provider.id}`"
                @click="deleteProvider(provider)"
              >
                {{ confirmDeleteId === provider.id ? 'Confirm delete' : 'Delete' }}
              </button>
            </div>
          </article>
        </div>

        <form
          class="space-y-3 rounded-box border border-base-300 bg-base-100 p-3"
          @submit.prevent="saveProvider"
        >
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs font-semibold">
              {{ editingId ? 'Edit provider' : 'Add provider' }}
            </h3>
            <button v-if="editingId" class="btn btn-ghost btn-xs" type="button" @click="resetForm">
              ＋ New
            </button>
          </div>

          <label class="form-control gap-1">
            <span class="text-[11px] opacity-70">Provider preset</span>
            <select
              v-model="selectedPreset"
              class="select select-bordered select-xs"
              @change="applyPreset"
            >
              <option value="">Choose a preset…</option>
              <option v-for="preset in presets" :key="preset.id" :value="preset.id">
                {{ preset.name }}
              </option>
            </select>
          </label>

          <div class="grid gap-2 sm:grid-cols-2">
            <label class="form-control gap-1">
              <span class="text-[11px] opacity-70">Provider ID</span>
              <input
                v-model="form.id"
                class="input input-bordered input-xs font-mono"
                maxlength="48"
                placeholder="my-nim"
                autocomplete="off"
                :disabled="!!editingId"
              />
            </label>
            <label class="form-control gap-1">
              <span class="text-[11px] opacity-70">Display name</span>
              <input
                v-model="form.name"
                class="input input-bordered input-xs"
                maxlength="80"
                placeholder="Team inference"
              />
            </label>
          </div>

          <label class="form-control gap-1">
            <span class="text-[11px] opacity-70">API compatibility</span>
            <select v-model="form.adapter" class="select select-bordered select-xs">
              <option value="openai-compatible">
                OpenAI-compatible Chat Completions (NIM/custom)
              </option>
              <option value="anthropic">Anthropic Messages API</option>
              <option value="gemini">Google Gemini API</option>
            </select>
          </label>

          <label class="form-control gap-1">
            <span class="text-[11px] opacity-70">Base URL</span>
            <input
              v-model="form.baseUrl"
              class="input input-bordered input-xs font-mono"
              maxlength="512"
              placeholder="https://integrate.api.nvidia.com/v1"
              autocomplete="url"
            />
          </label>

          <label class="form-control gap-1">
            <span class="text-[11px] opacity-70"
              >API key ·
              {{
                providers.find((provider) => provider.id === editingId)?.keyConfigured
                  ? 'saved; blank keeps it'
                  : 'never returned after saving'
              }}</span
            >
            <input
              ref="keyInput"
              v-model="form.apiKey"
              class="input input-bordered input-xs font-mono"
              type="password"
              autocomplete="new-password"
              placeholder="Paste API key"
            />
          </label>

          <label class="form-control gap-1">
            <span class="text-[11px] opacity-70"
              >Model IDs · one per line, or test to discover</span
            >
            <textarea
              v-model="form.modelIds"
              class="textarea textarea-bordered textarea-xs font-mono"
              rows="3"
              placeholder="meta/llama-3.1-8b-instruct"
            />
          </label>

          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary btn-xs" type="submit" :disabled="!canSave">
              <span v-if="saving" class="loading loading-spinner loading-xs" />
              {{ saving ? 'Saving…' : 'Save provider' }}
            </button>
            <button
              v-if="editingId"
              class="btn btn-ghost btn-xs"
              type="button"
              :disabled="
                !!testingId ||
                !providers.find((provider) => provider.id === editingId)?.keyConfigured
              "
              @click="testProvider(providers.find((provider) => provider.id === editingId)!)"
            >
              Test connection
            </button>
          </div>
          <p class="text-[10px] opacity-55">
            Keys are saved as <code>INFAGENT_CLOUD_&lt;ID&gt;_API_KEY</code> in .env. HTTPS is
            required except for localhost endpoints.
          </p>
        </form>
      </div>
    </div>
  </section>
</template>

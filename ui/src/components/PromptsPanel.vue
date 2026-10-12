<script setup lang="ts">
/**
 * Prompts tab: the agent's "way of thinking".
 *
 * Templates live in `models/systemPrompts.json` as an array of
 * `{ name, description, prompt }`, so they are plain data: editable here, in an
 * editor, or shared through git. The selected one is injected into every system
 * prompt as a short "Working style" section.
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { promptsApi } from '../api';
import type { SystemPromptTemplate } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const prompts = ref<SystemPromptTemplate[]>([]);
const active = ref('');
const file = ref('');
const selected = ref<string | null>(null);
const loading = ref(true);
const editing = ref(false);
const busy = ref(false);

const draft = reactive({ name: '', description: '', prompt: '' });

const current = computed(
  () => prompts.value.find((entry) => entry.name === selected.value) ?? null,
);

async function load(keepSelection = false): Promise<void> {
  loading.value = true;
  try {
    const catalogue = await promptsApi.list();
    prompts.value = catalogue.prompts;
    active.value = catalogue.active;
    file.value = catalogue.file;
    if (!keepSelection || !current.value) {
      selected.value = catalogue.prompts[0]?.name ?? null;
    }
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

async function select(name: string): Promise<void> {
  selected.value = name;
  editing.value = false;
  const template = prompts.value.find((entry) => entry.name === name);
  if (template) {
    draft.name = template.name;
    draft.description = template.description;
    draft.prompt = template.prompt;
  }
}

async function use(name: string): Promise<void> {
  busy.value = true;
  try {
    const result = await promptsApi.select(name);
    active.value = result.active;
    emit(
      'notify',
      result.active ? `Thinking style: ${result.active}` : 'Thinking style cleared',
      'success',
    );
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

function startCreate(): void {
  selected.value = null;
  editing.value = true;
  draft.name = '';
  draft.description = '';
  draft.prompt = '';
}

function startEdit(): void {
  const template = current.value;
  if (!template) return;
  draft.name = template.name;
  draft.description = template.description;
  draft.prompt = template.prompt;
  editing.value = true;
}

async function save(): Promise<void> {
  busy.value = true;
  try {
    const catalogue = await promptsApi.save({
      name: draft.name,
      description: draft.description,
      prompt: draft.prompt,
    });
    prompts.value = catalogue.prompts;
    active.value = catalogue.active;
    selected.value = draft.name.trim();
    editing.value = false;
    emit('notify', `Saved "${selected.value}"`, 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

async function duplicate(): Promise<void> {
  const template = current.value;
  if (!template) return;
  draft.name = `${template.name} copy`;
  draft.description = template.description;
  draft.prompt = template.prompt;
  editing.value = true;
}

async function remove(): Promise<void> {
  const template = current.value;
  if (!template) return;
  busy.value = true;
  try {
    const catalogue = await promptsApi.remove(template.name);
    prompts.value = catalogue.prompts;
    active.value = catalogue.active;
    selected.value = catalogue.prompts[0]?.name ?? null;
    emit('notify', `Removed "${template.name}"`, 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    busy.value = false;
  }
}

onMounted(() => load());
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[20rem_1fr]">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">
            Thinking styles
            <span class="badge badge-ghost badge-sm ml-1">{{ prompts.length }}</span>
          </h2>
          <button class="btn btn-primary btn-xs" @click="startCreate">New</button>
        </header>

        <div class="max-h-[26rem] space-y-1 overflow-y-auto">
          <p v-if="loading" class="px-1 py-4 text-xs opacity-60">loading…</p>
          <button
            v-for="template in prompts"
            :key="template.name"
            class="w-full rounded-box border px-2 py-1.5 text-left transition"
            :class="
              selected === template.name
                ? 'border-primary/60 bg-primary/10'
                : 'border-base-300 hover:border-primary/40'
            "
            @click="select(template.name)"
          >
            <p class="flex items-center gap-1 text-xs font-semibold">
              {{ template.name }}
              <span v-if="active === template.name" class="badge badge-success badge-xs"
                >active</span
              >
            </p>
            <p class="line-clamp-2 text-[11px] opacity-70">{{ template.description }}</p>
          </button>
        </div>

        <p class="text-[10px] leading-snug opacity-50">
          Stored in <span class="font-mono">{{ file || 'models/systemPrompts.json' }}</span>
        </p>
      </div>
    </section>

    <section class="card min-w-0 border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">
            {{
              editing
                ? selected
                  ? 'Edit template'
                  : 'New template'
                : (current?.name ?? 'Select a style')
            }}
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-if="current && !editing"
              class="btn btn-primary btn-xs"
              :disabled="busy || active === current.name"
              @click="use(current.name)"
            >
              {{ active === current.name ? '✓ In use' : 'Use this style' }}
            </button>
            <button
              v-if="active && !editing"
              class="btn btn-ghost btn-xs"
              :disabled="busy"
              @click="use('')"
            >
              None
            </button>
            <button v-if="current && !editing" class="btn btn-ghost btn-xs" @click="startEdit">
              Edit
            </button>
            <button v-if="current && !editing" class="btn btn-ghost btn-xs" @click="duplicate">
              Duplicate
            </button>
            <button v-if="editing" class="btn btn-primary btn-xs" :disabled="busy" @click="save">
              Save
            </button>
            <button v-if="editing" class="btn btn-ghost btn-xs" @click="editing = false">
              Cancel
            </button>
            <button
              v-if="current && !editing"
              class="btn btn-ghost btn-xs text-error"
              :disabled="busy"
              @click="remove"
            >
              Delete
            </button>
          </div>
        </header>

        <p v-if="!current && !editing" class="py-8 text-center text-xs opacity-60">
          Pick a style on the left, or create one. The selected style is added to every system
          prompt as a short “Working style” section.
        </p>

        <template v-if="editing">
          <label class="form-control">
            <span class="label-text text-[11px] opacity-70">Name</span>
            <input v-model="draft.name" class="input input-bordered input-sm font-mono" />
          </label>
          <label class="form-control">
            <span class="label-text text-[11px] opacity-70"
              >Description (one line, shown here)</span
            >
            <input v-model="draft.description" class="input input-bordered input-sm" />
          </label>
          <label class="form-control">
            <span class="label-text text-[11px] opacity-70">
              Prompt — what the model is told to do ({{ draft.prompt.length }}/4000)
            </span>
            <textarea
              v-model="draft.prompt"
              rows="9"
              class="textarea textarea-bordered font-mono text-xs"
            ></textarea>
          </label>
        </template>

        <template v-else-if="current">
          <p class="text-xs opacity-70">{{ current.description }}</p>
          <pre
            class="max-h-[24rem] overflow-auto rounded-box border border-base-300 bg-base-300/40 p-3 text-[11px] whitespace-pre-wrap"
            >{{ current.prompt }}</pre>
          <p class="text-[10px] opacity-50">
            {{ current.prompt.length }} characters · builtin {{ current.builtin ? 'yes' : 'no' }}
          </p>
        </template>
      </div>
    </section>
  </div>
</template>

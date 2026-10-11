<script setup lang="ts">
import { reactive, ref, watch } from 'vue';

import { api } from '../api';
import type { ScriptLanguage, ScriptParam, ScriptParamType } from '../types';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
  (event: 'created', name: string): void;
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

interface ParamRow extends ScriptParam {
  type: ScriptParamType;
}

const form = reactive({
  name: '',
  language: 'js' as ScriptLanguage,
  description: '',
  agentPrompt: '',
  overwrite: false,
});

const params = ref<ParamRow[]>([]);
const busy = ref(false);
const error = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.name = '';
    form.language = 'js';
    form.description = '';
    form.agentPrompt = '';
    form.overwrite = false;
    params.value = [];
    error.value = '';
  },
);

function addParam(): void {
  params.value.push({ name: '', type: 'string', required: false, description: '' });
}

function removeParam(index: number): void {
  params.value.splice(index, 1);
}

function close(): void {
  emit('update:open', false);
}

async function submit(): Promise<void> {
  error.value = '';
  const clean = params.value
    .filter((param) => param.name.trim().length > 0)
    .map((param) => ({
      name: param.name.trim(),
      type: param.type,
      required: Boolean(param.required),
      ...(param.description ? { description: param.description } : {}),
    }));

  if (!form.name.trim() || !form.description.trim()) {
    error.value = 'Name and description are required.';
    return;
  }

  busy.value = true;
  try {
    await api.createScript({
      name: form.name.trim(),
      language: form.language,
      description: form.description.trim(),
      params: clean,
      ...(form.agentPrompt.trim() ? { agentPrompt: form.agentPrompt.trim() } : {}),
      overwrite: form.overwrite,
    });
    emit('notify', `Created ${form.name.trim()}.${form.language}`, 'success');
    emit('created', form.name.trim());
    close();
  } catch (submitError) {
    error.value = (submitError as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': open }">
    <div class="modal-box max-w-2xl">
      <h3 class="text-lg font-semibold">New agent script</h3>
      <p class="mt-1 text-xs opacity-70">
        The header (description, callback, usage and agent prompt) is generated automatically, so
        the agent can discover and call the script without extra wiring.
      </p>

      <div class="mt-4 grid gap-3">
        <div class="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label class="form-control">
            <span class="mb-1 text-xs opacity-60">Name</span>
            <input
              v-model="form.name"
              class="input input-bordered input-sm font-mono"
              placeholder="disk_report"
            />
          </label>
          <label class="form-control">
            <span class="mb-1 text-xs opacity-60">Language</span>
            <select v-model="form.language" class="select select-bordered select-sm">
              <option value="js">.js (Node)</option>
              <option value="py">.py (Python 3)</option>
            </select>
          </label>
        </div>

        <label class="form-control">
          <span class="mb-1 text-xs opacity-60">Description (used as the "when to use" hint)</span>
          <input
            v-model="form.description"
            class="input input-bordered input-sm"
            placeholder="Report free disk space per mount point."
          />
        </label>

        <div>
          <div class="flex items-center justify-between">
            <span class="text-xs opacity-60">Arguments (JSON passed to the callback)</span>
            <button class="btn btn-ghost btn-xs" @click="addParam">+ argument</button>
          </div>

          <p v-if="params.length === 0" class="mt-1 text-xs opacity-50">
            No arguments — the script takes an empty object.
          </p>

          <div
            v-for="(param, index) in params"
            :key="index"
            class="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto_1.4fr_auto]"
          >
            <input
              v-model="param.name"
              class="input input-bordered input-xs font-mono"
              placeholder="name"
            />
            <select v-model="param.type" class="select select-bordered select-xs">
              <option>string</option>
              <option>number</option>
              <option>boolean</option>
              <option>object</option>
              <option>array</option>
              <option>any</option>
            </select>
            <label class="flex items-center gap-1 text-xs">
              <input v-model="param.required" type="checkbox" class="checkbox checkbox-xs" />
              req
            </label>
            <input
              v-model="param.description"
              class="input input-bordered input-xs"
              placeholder="description"
            />
            <button class="btn btn-ghost btn-xs text-error" @click="removeParam(index)">✕</button>
          </div>
        </div>

        <label class="form-control">
          <span class="mb-1 text-xs opacity-60">Custom agent prompt (optional)</span>
          <textarea
            v-model="form.agentPrompt"
            rows="3"
            class="textarea textarea-bordered textarea-sm"
            placeholder="Use this script when the user asks about disk usage. Never call it more than once per turn."
          ></textarea>
        </label>

        <label class="flex items-center gap-2 text-xs">
          <input v-model="form.overwrite" type="checkbox" class="checkbox checkbox-xs" />
          Overwrite if a script with this name already exists
        </label>

        <p v-if="error" class="text-xs text-error">{{ error }}</p>
      </div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="close">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy" @click="submit">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          Create script
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @submit="close">
      <button>close</button>
    </form>
  </dialog>
</template>

<script setup lang="ts">
/**
 * Skills tab: the agent's procedure library.
 *
 * A skill is a markdown file in `skills/`. The list shows name + description
 * (what the model sees in its prompt); the detail pane shows or edits the body
 * that is loaded on demand with `readSkill`.
 */
import { computed, onMounted, reactive, ref } from 'vue';

import { skillsApi } from '../api';
import type { SkillDetailFull, SkillRecord } from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const skills = ref<SkillRecord[]>([]);
const root = ref('');
const selected = ref<string | null>(null);
const detail = ref<SkillDetailFull | null>(null);
const loading = ref(false);
const editing = ref(false);
const creating = ref(false);
const filter = ref('');
const copied = ref(false);

const draft = reactive({ name: '', description: '', when: '', body: '' });

const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return skills.value;
  return skills.value.filter(
    (skill) =>
      skill.meta.name.includes(needle) ||
      skill.meta.description.toLowerCase().includes(needle) ||
      skill.meta.when.toLowerCase().includes(needle),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await skillsApi.list();
    skills.value = response.skills;
    root.value = response.root;
    if (skills.value.length > 0 && !selected.value) await open(skills.value[0]!.meta.name);
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

async function open(name: string): Promise<void> {
  try {
    const response = await skillsApi.read(name);
    selected.value = name;
    detail.value = response.skill;
    editing.value = false;
    creating.value = false;
    draft.name = response.skill.meta.name;
    draft.description = response.skill.meta.description;
    draft.when = response.skill.meta.when;
    draft.body = response.skill.body;
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

function startCreate(): void {
  creating.value = true;
  editing.value = true;
  selected.value = null;
  detail.value = null;
  draft.name = '';
  draft.description = '';
  draft.when = '';
  draft.body = '# Steps\n\n1. First step.\n2. Second step.';
}

function startEdit(): void {
  if (!detail.value) return;
  editing.value = true;
  draft.name = detail.value.meta.name;
  draft.description = detail.value.meta.description;
  draft.when = detail.value.meta.when;
  draft.body = detail.value.body;
}

async function save(): Promise<void> {
  try {
    if (creating.value) {
      const response = await skillsApi.create({
        name: draft.name.trim(),
        description: draft.description.trim(),
        ...(draft.when.trim() ? { when: draft.when.trim() } : {}),
        body: draft.body,
      });
      emit('notify', `Skill ${response.skill.meta.name} created`, 'success');
      await load();
      await open(response.skill.meta.name);
      return;
    }

    if (!selected.value) return;
    const response = await skillsApi.update(selected.value, {
      description: draft.description,
      when: draft.when,
      body: draft.body,
    });
    detail.value = response.skill;
    editing.value = false;
    emit('notify', `Skill ${selected.value} saved`, 'success');
    await load();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function remove(name: string): Promise<void> {
  if (!window.confirm(`Delete the skill "${name}"? This cannot be undone.`)) return;
  try {
    await skillsApi.remove(name);
    emit('notify', `Skill ${name} removed`, 'success');
    selected.value = null;
    detail.value = null;
    await load();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function copySkill(): Promise<void> {
  if (!detail.value) return;
  const text = detail.value.source;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
  }
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 1500);
}

onMounted(load);
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[20rem_1fr]">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">
            Skills
            <span class="badge badge-ghost badge-sm ml-1">{{ skills.length }}</span>
          </h2>
          <button class="btn btn-primary btn-xs" @click="startCreate">New</button>
        </header>

        <input
          v-model="filter"
          class="input input-bordered input-xs font-mono"
          placeholder="filter skills…"
        />

        <div class="max-h-[26rem] space-y-1 overflow-y-auto">
          <p v-if="loading" class="px-1 py-4 text-xs opacity-60">loading…</p>
          <p v-else-if="visible.length === 0" class="px-1 py-4 text-xs opacity-60">
            No skills yet — create one, or drop a `.md` file in {{ root || 'skills/' }}.
          </p>
          <button
            v-for="skill in visible"
            :key="skill.meta.name"
            class="w-full rounded-box border px-2 py-1.5 text-left transition"
            :class="
              selected === skill.meta.name
                ? 'border-primary/60 bg-primary/10'
                : 'border-base-300 hover:border-primary/40'
            "
            @click="open(skill.meta.name)"
          >
            <p class="font-mono text-xs">{{ skill.meta.name }}</p>
            <p class="line-clamp-2 text-[11px] opacity-70">{{ skill.meta.description }}</p>
          </button>
        </div>
      </div>
    </section>

    <section class="card min-w-0 border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3">
        <header class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold">
            {{ creating ? 'New skill' : (detail?.meta.name ?? 'Select a skill') }}
          </h2>
          <div class="flex flex-wrap items-center gap-2">
            <button v-if="detail && !editing" class="btn btn-ghost btn-xs" @click="copySkill">
              {{ copied ? '✓ Copied' : '⧉ Copy' }}
            </button>
            <button v-if="detail && !editing" class="btn btn-ghost btn-xs" @click="startEdit">
              Edit
            </button>
            <button v-if="editing" class="btn btn-primary btn-xs" @click="save">Save</button>
            <button v-if="editing" class="btn btn-ghost btn-xs" @click="editing = false">
              Cancel
            </button>
            <button
              v-if="detail && !editing"
              class="btn btn-ghost btn-xs text-error"
              @click="remove(detail.meta.name)"
            >
              Delete
            </button>
          </div>
        </header>

        <div v-if="editing" class="grid gap-2">
          <input
            v-model="draft.name"
            class="input input-bordered input-sm font-mono"
            placeholder="skill-name"
            :disabled="!creating"
          />
          <input
            v-model="draft.description"
            class="input input-bordered input-sm"
            placeholder="One line the model sees in its prompt"
          />
          <input
            v-model="draft.when"
            class="input input-bordered input-sm"
            placeholder="When should this skill be used?"
          />
          <textarea
            v-model="draft.body"
            rows="14"
            class="textarea textarea-bordered font-mono text-xs"
          ></textarea>
        </div>

        <div v-else-if="detail" class="grid gap-3">
          <p class="text-xs opacity-80">{{ detail.meta.description }}</p>
          <p v-if="detail.meta.when" class="text-[11px] opacity-60">
            <strong>use when:</strong> {{ detail.meta.when }}
          </p>
          <pre
            class="max-h-[26rem] overflow-auto rounded-box bg-base-300/40 p-3 text-xs whitespace-pre-wrap"
            >{{ detail.body }}</pre
          >
          <p class="font-mono text-[11px] opacity-50">
            {{ detail.relativePath }} · {{ detail.bytes }} bytes
          </p>
        </div>

        <p v-else class="py-10 text-center text-xs opacity-60">
          Pick a skill on the left — or let the agent write one with <code>createSkill</code>.
        </p>
      </div>
    </section>
  </div>
</template>

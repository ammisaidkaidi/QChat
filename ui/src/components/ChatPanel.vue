<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';

import { pushAlert, raiseAlert } from '../alerts';
import { chatApi, streamChat } from '../api';
import type { ChatStreamHandle } from '../api';
import type {
  ChatConfig,
  ChatEvent,
  ChatMessage,
  ChatTurn,
  EngineStatus,
  ModelCatalog,
  ModelRecord,
} from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const STORAGE_KEY = 'infagent.chat.v1';

const status = ref<EngineStatus | null>(null);
const config = ref<ChatConfig | null>(null);
const catalog = ref<ModelCatalog | null>(null);
const switching = ref(false);
/** Turn id whose text was copied last, for the "copied" tick. */
const copied = ref<string | null>(null);
const turns = ref<ChatTurn[]>([]);
const draft = ref('');
const busy = ref(false);
const downloading = ref(false);
const showSettings = ref(false);
const showPrompt = ref(false);
const startedAt = ref<number | null>(null);
const elapsed = ref(0);
const scroller = ref<HTMLElement | null>(null);

let handle: ChatStreamHandle | null = null;
let clock: number | null = null;

const settings = reactive({
  temperature: 0.4,
  maxTokens: 512,
  thinking: false,
  tools: true,
  /** Let the model search the internet and read pages. */
  net: true,
  systemPrompt: '',
});

const stateLabel = computed(() => {
  switch (status.value?.state) {
    case 'ready':
      return 'ready';
    case 'idle':
      return 'idle (loads on first message)';
    case 'loading':
      return 'loading…';
    case 'downloading':
      return 'downloading…';
    case 'absent':
      return 'model not downloaded';
    case 'unavailable':
      return 'engine unavailable';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
});

const canChat = computed(
  () => status.value !== null && ['ready', 'idle', 'loading'].includes(status.value.state),
);

/* ── persistence ─────────────────────────────────────────────────────────── */

/** Snapshot of what is stored; the Save button is what moves settings into it. */
const saved = ref('{}');
const justSaved = ref(false);
let savedTimer: number | null = null;

function write(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ turns: turns.value.slice(-40), settings: JSON.parse(saved.value) }),
    );
  } catch {
    /* storage may be unavailable */
  }
}

/** Changes made since the last save, shown next to the button. */
const dirty = computed(() => JSON.stringify({ ...settings }) !== saved.value);

function saveSettings(): void {
  saved.value = JSON.stringify({ ...settings });
  write();
  justSaved.value = true;
  if (savedTimer !== null) window.clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (justSaved.value = false), 1600);
  emit('notify', 'Settings saved', 'success');
}

function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      saved.value = JSON.stringify({ ...settings });
      return;
    }
    const parsed = JSON.parse(raw) as { turns?: ChatTurn[]; settings?: Partial<typeof settings> };
    if (Array.isArray(parsed.turns)) turns.value = parsed.turns.slice(-40);
    if (parsed.settings) Object.assign(settings, parsed.settings);
  } catch {
    /* ignore corrupt state */
  }
  saved.value = JSON.stringify({ ...settings });
}

// Turns keep persisting on their own; settings only move when Save is pressed.
watch(turns, write, { deep: true });
watch(saved, write);

/* ── engine status ───────────────────────────────────────────────────────── */

const activeModel = computed<ModelRecord | null>(
  () => catalog.value?.models.find((model) => model.settings.id === catalog.value?.active) ?? null,
);

function formatSize(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1048576).toFixed(0)} MB` : 'not downloaded';
}

async function loadModels(): Promise<void> {
  try {
    catalog.value = await chatApi.models();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

/** Switch the model backing the chat; the weights load lazily. */
async function selectModel(event: Event): Promise<void> {
  const id = (event.target as HTMLSelectElement).value;
  if (!id || id === catalog.value?.active) return;

  switching.value = true;
  try {
    const response = await chatApi.useModel(id);
    catalog.value = {
      dir: response.dir,
      weightsDir: response.weightsDir,
      active: response.active,
      models: response.models,
    };
    status.value = response.status;
    if (!response.status.modelPresent) {
      emit(
        'notify',
        `${response.status.modelName} is selected — download its weights to chat`,
        'error',
      );
    } else {
      emit('notify', `Now using ${response.status.modelName}`, 'success');
    }
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
    await loadModels();
  } finally {
    switching.value = false;
  }
}

/**
 * Copy a reply to the clipboard.
 *
 * The console is often embedded in an iframe where the async clipboard API is
 * blocked, so a hidden textarea + `execCommand` is kept as a fallback.
 */
async function copyText(text: string): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

async function copyTurn(turn: ChatTurn): Promise<void> {
  const ok = await copyText(turn.text);
  if (!ok) {
    emit('notify', 'Copy failed — select the text and copy manually', 'error');
    return;
  }
  copied.value = turn.id;
  window.setTimeout(() => {
    if (copied.value === turn.id) copied.value = null;
  }, 1600);
}

async function refresh(): Promise<void> {
  try {
    const response = await chatApi.status();
    status.value = response.status;
    config.value = response.config;
    if (!settings.systemPrompt && response.config)
      settings.maxTokens = settings.maxTokens || response.config.defaultMaxTokens;
    // That default is not a user edit: keep it out of the "unsaved changes" state.
    if (!dirty.value) saved.value = JSON.stringify({ ...settings });
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function download(): Promise<void> {
  downloading.value = true;
  chatApi.download(
    (progress, next) => {
      status.value = next;
      void progress;
    },
    (next) => {
      status.value = next;
      downloading.value = false;
      emit('notify', 'Model downloaded — first reply also loads it into memory', 'success');
    },
    (message) => {
      downloading.value = false;
      emit('notify', message, 'error');
    },
    status.value && !status.value.modelPresent ? status.value.modelId : undefined,
  );
}

async function unload(): Promise<void> {
  try {
    const response = await chatApi.unload();
    status.value = response.status;
    emit('notify', 'Model unloaded from memory', 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

/* ── conversation ────────────────────────────────────────────────────────── */

/**
 * Push a turn and return the reactive proxy for it — mutating the raw object
 * would not re-render the template.
 */
function newTurn(role: ChatTurn['role']): ChatTurn {
  turns.value.push({
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    text: '',
    thinking: '',
    calls: [],
    ...(role === 'assistant' ? { streaming: true } : {}),
  });
  const created = turns.value[turns.value.length - 1];
  if (!created) throw new Error('Turn could not be created.');
  return created;
}

const history = computed<ChatMessage[]>(() =>
  turns.value
    .filter((turn) => turn.text.trim().length > 0 && !turn.streaming)
    .map((turn) => ({ role: turn.role, content: turn.text })),
);

function applyEvent(turn: ChatTurn, event: ChatEvent): void {
  switch (event.type) {
    case 'thinking':
      turn.thinking += event.text;
      break;
    case 'token':
      turn.text += event.text;
      break;
    case 'reset':
      // The engine decided the partial reply was unusable and is retrying.
      turn.text = '';
      turn.thinking = '';
      break;
    case 'tool_call':
      turn.calls.push({ ...event.call });
      break;
    case 'tool_result': {
      const index = turn.calls.findIndex(
        (call) => call.name === event.call.name && call.durationMs === undefined,
      );
      if (index === -1) turn.calls.push({ ...event.call });
      else turn.calls[index] = { ...event.call };
      break;
    }
    case 'alert':
      // showAlert fired during this turn: the toast (and bell counter) shows it.
      pushAlert(event.alert);
      break;
    case 'stats':
      turn.stats = {
        totalTokens: event.totalTokens,
        tokensPerSecond: event.tokensPerSecond,
        durationMs: event.durationMs,
      };
      break;
    case 'error':
      turn.error = event.message;
      break;
    default:
      break;
  }
}

async function sendTestAlert(): Promise<void> {
  try {
    await raiseAlert({
      title: 'Test alert',
      message: 'Sent from the console — the model raises the same thing with showAlert.',
      level: 'info',
    });
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const element = scroller.value;
  if (element) element.scrollTop = element.scrollHeight;
}

function startClock(): void {
  startedAt.value = Date.now();
  clock = window.setInterval(() => {
    elapsed.value = Math.round((Date.now() - (startedAt.value ?? Date.now())) / 100) / 10;
  }, 200);
}

function stopClock(): void {
  if (clock !== null) window.clearInterval(clock);
  clock = null;
  startedAt.value = null;
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || busy.value) return;

  newTurn('user').text = text;
  draft.value = '';
  const assistant = newTurn('assistant');
  busy.value = true;
  startClock();
  await scrollToBottom();

  handle = streamChat({
    messages: [...history.value, { role: 'user', content: text }],
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    thinking: settings.thinking,
    tools: settings.tools,
    net: settings.net,
    systemPrompt: settings.systemPrompt,
    onEvent: (event) => {
      applyEvent(assistant, event);
      void scrollToBottom();
    },
    onError: (message) => {
      assistant.error = message;
      emit('notify', message, 'error');
    },
    onClose: () => {
      assistant.streaming = false;
      if (!assistant.text && !assistant.error && assistant.calls.length > 0) {
        assistant.text = assistant.calls
          .map((call) => `${call.name} → ${call.ok === false ? (call.error ?? 'failed') : 'done'}`)
          .join('\n');
      }
      busy.value = false;
      stopClock();
      handle = null;
      void refresh();
      void scrollToBottom();
    },
  });
}

function stop(): void {
  handle?.abort();
  handle = null;
  busy.value = false;
  stopClock();
  emit('notify', 'Generation stopped', 'success');
}

function clear(): void {
  stop();
  turns.value = [];
  emit('notify', 'Conversation cleared', 'success');
}

/** Drop the last exchange and ask the same question again. */
/**
 * Ask the last question again.
 *
 * With a turn id the retry happens right after that exchange (the button on each
 * reply); without one it repeats the newest question (the composer button).
 */
function regenerate(turnId?: string): void {
  const index = turnId
    ? turns.value.findIndex((turn) => turn.id === turnId)
    : turns.value.map((turn) => turn.role).lastIndexOf('user');
  if (index === -1) return;

  let userIndex = index;
  while (userIndex >= 0 && turns.value[userIndex]?.role !== 'user') userIndex -= 1;
  if (userIndex === -1) return;

  const question = turns.value[userIndex]?.text ?? '';
  if (!question.trim()) return;
  turns.value.splice(userIndex);
  draft.value = question;
  void send();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

function promptPreview(): string {
  if (!config.value) return '';
  return [
    `# InfAgent chat (Qwen3-0.6B, ${status.value?.quantization ?? 'Q4_K_M'}, CPU only)`,
    '',
    `context : ${config.value.contextSize} tokens · threads ${config.value.threads}`,
    `scripts : ${config.value.scriptCount} exposed as tools`,
    `thinking: ${settings.thinking ? 'on' : 'off (default — a 0.6B model is much faster without it)'}`,
    '',
    'The model runs entirely on this machine through llama.cpp.',
    `Model settings: ${status.value?.settingsFile ?? '—'}`,
    `Weights folder: ${status.value?.weightsDir ?? '—'}`,
    'Tool calls are `<tool_call>{"name": "...", "args": {...}}</tool_call>` blocks,',
    'executed against the same script folder as the Scripts tab.',
  ].join('\n');
}

onMounted(async () => {
  restore();
  await Promise.all([refresh(), loadModels()]);
  window.setInterval(() => {
    void refresh();
    if (!switching.value) void loadModels();
  }, 20_000);
});
</script>

<template>
  <div class="grid gap-4">
    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-lg"
              >🤖</span
            >
            <div>
              <h2 class="card-title text-base">
                {{ status?.modelName ?? 'Qwen3 0.6B (Q4_K_M)' }}
                <span v-if="status?.quantization" class="badge badge-sm badge-ghost font-mono">{{
                  status.quantization
                }}</span>
              </h2>
              <p class="text-[11px] opacity-70">
                local · CPU {{ status?.threads ?? config?.threads ?? 2 }} threads · ctx
                {{ status?.contextSize ?? config?.contextSize ?? 0 }} · RAM
                {{ status?.ramUsedMb ?? 0 }} MB
              </p>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <select
              v-if="catalog && catalog.models.length > 0"
              class="select select-bordered select-xs max-w-[13rem] font-mono"
              :value="catalog.active"
              :disabled="switching || busy"
              :title="activeModel?.settings.description ?? status?.description ?? ''"
              aria-label="Active model"
              @change="selectModel"
            >
              <option
                v-for="model in catalog.models"
                :key="model.settings.id"
                :value="model.settings.id"
              >
                {{ model.settings.id }}{{ model.present ? '' : ' — needs download' }}
              </option>
            </select>

            <span
              class="badge badge-sm gap-1"
              :class="{
                'badge-success': status?.state === 'ready',
                'badge-warning': status?.state === 'downloading',
                'badge-info': status?.state === 'loading',
                'badge-error': status?.state === 'error' || status?.state === 'unavailable',
                'badge-ghost': status?.state === 'absent',
              }"
            >
              <span
                v-if="status?.state === 'loading' || status?.state === 'downloading'"
                class="loading loading-spinner loading-xs"
              />
              {{ stateLabel }}
            </span>

            <button
              v-if="status?.state === 'absent' || (activeModel && !activeModel.present)"
              class="btn btn-primary btn-xs"
              :disabled="downloading"
              @click="download"
            >
              <span v-if="downloading" class="loading loading-spinner loading-xs" />
              {{
                downloading ? 'Downloading' : `Download ${formatSize(activeModel?.sizeBytes ?? 0)}`
              }}
            </button>
            <button
              v-if="status?.modelPresent && status?.state === 'ready'"
              class="btn btn-ghost btn-xs"
              @click="unload"
            >
              Unload
            </button>
            <button class="btn btn-ghost btn-xs" @click="showPrompt = !showPrompt">Info</button>
            <button
              class="btn btn-xs"
              :class="showSettings ? 'btn-primary' : 'btn-ghost border border-base-300'"
              @click="showSettings = !showSettings"
            >
              Settings
            </button>
            <button class="btn btn-ghost btn-xs text-error" @click="clear">Clear</button>
          </div>
        </header>

        <div v-if="status?.state === 'downloading'" class="space-y-1">
          <progress
            class="progress progress-primary w-full"
            :value="status.downloadProgress * 100"
            max="100"
          />
          <p class="text-[11px] opacity-70">
            {{ (status.downloadedBytes / 1048576).toFixed(1) }} MB of
            {{ (status.downloadTotalBytes / 1048576).toFixed(1) }} MB — fetched once, kept in
            {{ config?.modelsDir }}
          </p>
        </div>

        <div v-if="status?.state === 'absent'" class="alert py-2 text-xs">
          <span>
            {{ status?.modelName ?? 'This model' }} ({{ formatSize(activeModel?.sizeBytes ?? 0) }},
            GGUF {{ status?.quantization || 'quantized' }} from Hugging Face) is not on this machine
            yet. Download it once — chat runs fully offline afterwards.
          </span>
        </div>

        <div
          v-if="status?.state === 'unavailable' || status?.lastError"
          class="alert alert-warning py-2 text-xs"
        >
          <span>{{
            status?.lastError ?? 'The local engine is unavailable. Run `npm install` to enable it.'
          }}</span>
        </div>

        <pre
          v-if="showPrompt"
          class="rounded-box bg-base-300/50 p-3 font-mono text-[11px] whitespace-pre-wrap"
          >{{ promptPreview() }}</pre>

        <div
          v-if="showSettings"
          class="grid gap-3 rounded-box border border-base-300 p-3 sm:grid-cols-2"
        >
          <label class="form-control">
            <span class="mb-1 flex items-center justify-between text-xs opacity-70">
              Temperature <span class="font-mono">{{ settings.temperature.toFixed(1) }}</span>
            </span>
            <input
              v-model.number="settings.temperature"
              type="range"
              min="0"
              max="1.2"
              step="0.1"
              class="range range-xs range-primary"
            />
          </label>
          <label class="form-control">
            <span class="mb-1 text-xs opacity-70">Max new tokens</span>
            <input
              v-model.number="settings.maxTokens"
              type="number"
              min="64"
              max="1024"
              step="32"
              class="input input-bordered input-xs"
            />
          </label>
          <label class="flex items-center gap-2 text-xs">
            <input v-model="settings.thinking" type="checkbox" class="toggle toggle-sm" />
            Thinking mode (slower, shows a reasoning block)
          </label>
          <label class="flex items-center gap-2 text-xs">
            <input v-model="settings.tools" type="checkbox" class="toggle toggle-sm" />
            Let the model call scripts as tools
          </label>
          <label class="flex items-center gap-2 text-xs">
            <input v-model="settings.net" type="checkbox" class="toggle toggle-sm" />
            Internet access (webSearch, webFetch)
          </label>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              class="btn btn-ghost btn-xs"
              title="Raise an alert the same way showAlert does"
              @click="sendTestAlert"
            >
              🔔 Send a test alert
            </button>
            <span class="text-[11px] opacity-60">
              the model calls showAlert on its own when you ask for an alert
            </span>
          </div>
          <label class="form-control sm:col-span-2">
            <span class="mb-1 text-xs opacity-70"
              >Custom system prompt (empty = generated with the script toolbox)</span
            >
            <textarea
              v-model="settings.systemPrompt"
              rows="2"
              class="textarea textarea-bordered textarea-xs font-mono"
            ></textarea>
          </label>

          <div class="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3 sm:col-span-2">
            <button
              class="btn btn-primary btn-sm"
              :class="{ 'btn-success': justSaved }"
              :disabled="!dirty && !justSaved"
              title="Store these settings in this browser"
              data-testid="save-settings"
              @click="saveSettings"
            >
              {{ justSaved ? '✓ Saved' : 'Save settings' }}
            </button>
            <span v-if="dirty" class="badge badge-warning badge-sm">unsaved changes</span>
            <span v-else class="text-[11px] opacity-60">
              settings apply to the next message and are restored on reload
            </span>
          </div>
        </div>
      </div>
    </section>

    <section class="card border border-base-300 bg-base-200/70">
      <div class="card-body gap-3 p-3 sm:p-4">
        <div ref="scroller" class="max-h-[52vh] min-h-[18rem] space-y-3 overflow-y-auto px-1">
          <div v-if="turns.length === 0" class="grid place-items-center gap-2 py-14 text-center">
            <p class="text-sm opacity-80">
              Ask the on-device model anything — or let it run your scripts.
            </p>
            <p class="max-w-md text-xs opacity-60">
              Try: “Use a tool to greet Amina”, “Which scripts do you have?”, or “Explain what DPDP
              means in one line.”
            </p>
          </div>

          <div
            v-for="turn in turns"
            :key="turn.id"
            class="chat"
            :class="turn.role === 'user' ? 'chat-end' : 'chat-start'"
          >
            <div class="chat-image avatar">
              <div
                class="w-8 rounded-full text-xs"
                :class="
                  turn.role === 'user'
                    ? 'bg-primary/25 grid place-items-center'
                    : 'bg-secondary/25 grid place-items-center'
                "
              >
                {{ turn.role === 'user' ? '🧑' : '🤖' }}
              </div>
            </div>

            <div
              class="chat-bubble max-w-[min(46rem,88vw)] text-sm"
              :class="turn.role === 'user' ? 'chat-bubble-primary' : ''"
            >
              <details v-if="turn.thinking.trim()" class="mb-2 opacity-80">
                <summary class="cursor-pointer text-[11px]">
                  reasoning ({{ turn.thinking.length }} chars)
                </summary>
                <pre
                  class="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap"
                  >{{ turn.thinking }}</pre>
              </details>

              <p v-if="turn.text" class="whitespace-pre-wrap">{{ turn.text }}</p>
              <span v-else-if="turn.streaming" class="loading loading-dots loading-sm" />

              <div
                v-for="(call, index) in turn.calls"
                :key="index"
                class="mt-2 rounded-box border border-base-content/15 bg-base-100/20 p-2"
              >
                <div class="flex items-center justify-between gap-2 text-[11px]">
                  <span class="font-mono">🛠 {{ call.name }}({{ JSON.stringify(call.args) }})</span>
                  <span
                    class="badge badge-xs"
                    :class="
                      call.ok === false ? 'badge-error' : call.ok ? 'badge-success' : 'badge-ghost'
                    "
                  >
                    {{
                      call.ok === undefined
                        ? 'running'
                        : call.ok
                          ? `${call.durationMs ?? 0}ms`
                          : 'failed'
                    }}
                  </span>
                </div>
                <pre
                  v-if="call.result !== undefined || call.error"
                  class="mt-1 max-h-28 overflow-auto font-mono text-[10px] whitespace-pre-wrap opacity-80"
                  >{{ call.error ?? JSON.stringify(call.result) }}</pre>
              </div>

              <p v-if="turn.error" class="mt-1 text-xs text-error">{{ turn.error }}</p>
            </div>

            <div
              v-if="turn.role === 'assistant' && !turn.streaming && (turn.text || turn.stats)"
              class="chat-footer flex items-center gap-2 text-[10px] opacity-60"
            >
              <span v-if="turn.stats" class="opacity-80">
                {{ turn.stats.totalTokens }} tok · {{ turn.stats.tokensPerSecond }} tok/s ·
                {{ (turn.stats.durationMs / 1000).toFixed(1) }}s
              </span>
              <button
                v-if="turn.text.trim()"
                class="btn btn-ghost btn-xs gap-1 px-2"
                :title="copied === turn.id ? 'Copied to the clipboard' : 'Copy this response'"
                @click="copyTurn(turn)"
              >
                {{ copied === turn.id ? '✓ Copied' : '⧉ Copy' }}
              </button>
              <button
                v-if="turn.text.trim()"
                class="btn btn-ghost btn-xs gap-1 px-2"
                title="Ask again with the same message"
                @click="regenerate(turn.id)"
              >
                ↻ Retry
              </button>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-end gap-2">
          <textarea
            v-model="draft"
            rows="2"
            class="textarea textarea-bordered textarea-sm flex-1"
            :placeholder="
              canChat
                ? 'Message the on-device model…  (Enter to send, Shift+Enter for a new line)'
                : 'Load the model first'
            "
            :disabled="busy"
            @keydown="onKeydown"
          ></textarea>
          <div class="flex items-center gap-2">
            <button
              v-if="!busy"
              class="btn btn-primary btn-sm"
              :disabled="!draft.trim() || !canChat"
              @click="send"
            >
              Send
            </button>
            <button v-else class="btn btn-error btn-sm" @click="stop">
              <span class="loading loading-spinner loading-xs" /> Stop
              {{ elapsed ? `${elapsed}s` : '' }}
            </button>
            <button v-if="turns.length > 1" class="btn btn-ghost btn-sm" @click="regenerate()">
              Retry
            </button>
          </div>
        </div>

        <p class="text-[10px] opacity-50">
          Everything runs locally through llama.cpp — no API key, no data leaving the machine.
          <span v-if="settings.tools"> Tool calls execute scripts from the Scripts tab.</span>
        </p>
      </div>
    </section>
  </div>
</template>

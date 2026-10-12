<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { pushAlert, raiseAlert } from '../alerts';
import { chatHistoryFromTurns } from '../chatHistory';
import {
  applyMention,
  attachedSkills,
  dropMention,
  filterSkills,
  mentionAt,
  type Mention,
} from '../mentions';
import {
  chatApi,
  chatsApi,
  cloudProvidersApi,
  mcpApi,
  promptsApi,
  skillsApi,
  streamChat,
} from '../api';
import type { ChatStreamHandle } from '../api';
import type {
  ChatConfig,
  ChatEvent,
  ChatMessage,
  ChatSettings,
  CloudProvider,
  ChatSummary,
  ChatTurn,
  StoredChat,
  EngineStatus,
  McpCatalogue,
  SkillRecord,
  ModelCatalog,
  ModelRecord,
} from '../types';

const emit = defineEmits<{
  (event: 'notify', message: string, tone: 'success' | 'error'): void;
}>();

const LEGACY_STORAGE_KEY = 'infagent.chat.v1';
const ACTIVE_CHAT_KEY = 'infagent.chat.active.v1';
const LEGACY_IMPORT_KEY = 'infagent.chat.import-id.v1';

const status = ref<EngineStatus | null>(null);
const config = ref<ChatConfig | null>(null);
const catalog = ref<ModelCatalog | null>(null);
const cloudProviders = ref<CloudProvider[]>([]);
const cloudProvidersLoading = ref(false);
const cloudProvidersReady = ref(false);
const modelPicker = ref(false);
const modelPickerWrap = ref<HTMLElement | null>(null);
const switching = ref(false);
/** Turn id whose text was copied last, for the "copied" tick. */
const copied = ref<string | null>(null);
const turns = ref<ChatTurn[]>([]);
const chats = ref<ChatSummary[]>([]);
const activeChatId = ref('');
const historyReady = ref(false);
const historyLoading = ref(true);
const savingState = ref<'saved' | 'saving' | 'error'>('saved');
const historyFilter = ref('');
const deletingChat = ref(false);
const confirmDeleteId = ref('');
const draft = ref('');
const busy = ref(false);
const downloading = ref(false);
const showSettings = ref(false);
/** Thinking styles offered by the Prompts tab; the selected one shapes every turn. */
const styles = ref<{ name: string; description: string; prompt: string }[]>([]);
const defaultStyleName = ref('');
const activeStyle = computed(() => settings.styleName);
const showPrompt = ref(false);
const startedAt = ref<number | null>(null);
const elapsed = ref(0);
const scroller = ref<HTMLElement | null>(null);
/** MCP servers, for the wrench picker next to the message box. */
const mcpCatalogue = ref<McpCatalogue | null>(null);
const mcpPicker = ref(false);
const mcpWrap = ref<HTMLElement | null>(null);
/** The skills `/` can complete to, as the Skills tab sees them. */
const skillList = ref<SkillRecord[]>([]);
/** The `/word` under the caret, when one is being typed. */
const mention = ref<Mention | null>(null);
/** Which row of the completion list is highlighted. */
const mentionIndex = ref(0);
const draftBox = ref<HTMLTextAreaElement | null>(null);

let handle: ChatStreamHandle | null = null;
let clock: number | null = null;
let settingsSaveTimer: number | null = null;
let turnsSaveTimer: number | null = null;
let periodicRefresh: number | null = null;
let applyingChat = false;

const settings = reactive({
  temperature: 0.4,
  maxTokens: 512,
  thinking: false,
  tools: true,
  /** Let the model search the internet and read pages. */
  net: true,
  systemPrompt: '',
  /** Tool steps a single reply may take (several calls + results + answer). */
  maxSteps: 6,
  /**
   * MCP servers this chat may use, by name. `null` = every enabled server,
   * `[]` = none at all, a list = exactly those (the 🔧 button by the box).
   */
  mcpServers: null as string[] | null,
  modelSource: 'local' as 'local' | 'cloud',
  providerId: '',
  /** Per-chat model; loaded when this chat is selected and included per request. */
  modelId: '',
  /** Per-chat selected template name (the template itself stays in models/). */
  styleName: '',
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

const selectedCloudProvider = computed(
  () => cloudProviders.value.find((provider) => provider.id === settings.providerId) ?? null,
);
const selectedCloudModel = computed(
  () => selectedCloudProvider.value?.models.find((model) => model.id === settings.modelId) ?? null,
);
const localModels = computed(() => catalog.value?.models.filter((model) => model.present) ?? []);
const selectedModelLabel = computed(() => {
  if (settings.modelSource === 'cloud') {
    if (selectedCloudProvider.value && selectedCloudModel.value) {
      return `${selectedCloudProvider.value.name} · ${selectedCloudModel.value.id}`;
    }
    return 'Cloud model not configured';
  }
  return (
    catalog.value?.models.find((model) => model.settings.id === settings.modelId)?.settings.id ||
    settings.modelId ||
    catalog.value?.active ||
    'Choose a model'
  );
});
const canChat = computed(
  () =>
    historyReady.value &&
    activeChatId.value.length > 0 &&
    (settings.modelSource === 'cloud'
      ? Boolean(selectedCloudProvider.value?.keyConfigured && selectedCloudModel.value)
      : status.value !== null && ['ready', 'idle', 'loading'].includes(status.value.state)),
);

/* ── persistence: SQLite on the server, each chat owns its own settings ──── */

const activeChat = computed(
  () => chats.value.find((chat) => chat.id === activeChatId.value) ?? null,
);
const filteredChats = computed(() => {
  const query = historyFilter.value.trim().toLowerCase();
  if (!query) return chats.value;
  return chats.value.filter((chat) =>
    `${chat.title} ${chat.preview}`.toLowerCase().includes(query),
  );
});
const saveLabel = computed(() =>
  savingState.value === 'saving'
    ? 'Saving to SQLite…'
    : savingState.value === 'error'
      ? 'Save failed — retry on next change'
      : 'Saved to this chat',
);

function chatUpdatedLabel(timestamp: string): string {
  const updated = Date.parse(timestamp);
  if (!Number.isFinite(updated)) return '';
  const age = Math.max(0, Date.now() - updated);
  if (age < 60_000) return 'now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return new Date(updated).toLocaleDateString();
}

function currentSettings(): ChatSettings {
  return {
    ...settings,
    mcpServers: settings.mcpServers === null ? null : [...settings.mcpServers],
  };
}

function serialisedTurns(): ChatTurn[] {
  return JSON.parse(JSON.stringify(turns.value)) as ChatTurn[];
}

function defaultChatSettings(): ChatSettings {
  const modelId =
    catalog.value?.defaultActive || catalog.value?.active || status.value?.modelId || '';
  const globalModel = catalog.value?.models.find((model) => model.settings.id === modelId);
  return {
    temperature: globalModel?.settings.temperature ?? config.value?.defaultTemperature ?? 0.4,
    maxTokens: globalModel?.settings.maxTokens ?? config.value?.defaultMaxTokens ?? 512,
    thinking: globalModel?.settings.thinking ?? config.value?.thinking ?? false,
    tools: config.value?.tools ?? true,
    net: true,
    systemPrompt: '',
    maxSteps: 6,
    mcpServers: null,
    modelSource: 'local',
    providerId: '',
    modelId,
    styleName: defaultStyleName.value,
  };
}

function readBrowserValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeBrowserValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The SQLite history remains usable when browser storage is unavailable.
  }
}

function removeBrowserValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // The migration id remains deterministic for this legacy transcript.
  }
}

function rememberSummary(summary: ChatSummary): void {
  const index = chats.value.findIndex((chat) => chat.id === summary.id);
  if (index === -1) chats.value.push(summary);
  else chats.value[index] = summary;
  chats.value.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function forgetSummary(id: string): void {
  chats.value = chats.value.filter((chat) => chat.id !== id);
}

async function persistSettings(id: string, snapshot: ChatSettings): Promise<boolean> {
  try {
    savingState.value = 'saving';
    const response = await chatsApi.updateSettings(id, snapshot);
    rememberSummary(response.chat);
    if (activeChatId.value === id) savingState.value = 'saved';
    return true;
  } catch (error) {
    if (activeChatId.value === id) savingState.value = 'error';
    console.error('[chat] settings could not be saved to SQLite:', error);
    return false;
  }
}

async function persistTurns(id: string, snapshot: ChatTurn[]): Promise<boolean> {
  try {
    savingState.value = 'saving';
    const response = await chatsApi.saveTurns(id, snapshot);
    rememberSummary(response.chat);
    if (activeChatId.value === id) savingState.value = 'saved';
    return true;
  } catch (error) {
    if (activeChatId.value === id) savingState.value = 'error';
    console.error('[chat] transcript could not be saved to SQLite:', error);
    return false;
  }
}

function scheduleSettingsSave(): void {
  if (!historyReady.value || applyingChat || !activeChatId.value) return;
  if (settingsSaveTimer !== null) window.clearTimeout(settingsSaveTimer);
  const id = activeChatId.value;
  settingsSaveTimer = window.setTimeout(() => {
    settingsSaveTimer = null;
    void persistSettings(id, currentSettings());
  }, 350);
}

function scheduleTurnsSave(): void {
  // The new user turn is saved before generation; avoid replacing the entire
  // transcript on every streamed token. The completed/aborted turn is saved in
  // one snapshot from onClose/stop.
  if (!historyReady.value || applyingChat || !activeChatId.value || busy.value) return;
  if (turnsSaveTimer !== null) window.clearTimeout(turnsSaveTimer);
  const id = activeChatId.value;
  turnsSaveTimer = window.setTimeout(() => {
    turnsSaveTimer = null;
    void persistTurns(id, serialisedTurns());
  }, 800);
}

async function flushPersistence(): Promise<boolean> {
  const id = activeChatId.value;
  if (!id || !historyReady.value) return true;
  if (settingsSaveTimer !== null) window.clearTimeout(settingsSaveTimer);
  if (turnsSaveTimer !== null) window.clearTimeout(turnsSaveTimer);
  settingsSaveTimer = null;
  turnsSaveTimer = null;
  const [settingsSaved, turnsSaved] = await Promise.all([
    persistSettings(id, currentSettings()),
    persistTurns(id, serialisedTurns()),
  ]);
  return settingsSaved && turnsSaved;
}

async function saveCurrentSettings(): Promise<void> {
  const id = activeChatId.value;
  if (id) await persistSettings(id, currentSettings());
}

watch(settings, scheduleSettingsSave, { deep: true, flush: 'sync' });
watch(turns, scheduleTurnsSave, { deep: true, flush: 'sync' });

function summaryFromRecord(chat: StoredChat): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    preview: chat.preview,
    turnCount: chat.turnCount,
    modelSource: chat.modelSource,
    providerId: chat.providerId,
    modelId: chat.modelId,
  };
}

function applyStoredChat(chat: StoredChat): void {
  applyingChat = true;
  activeChatId.value = chat.id;
  Object.assign(settings, chat.settings);
  turns.value = chat.turns;
  draft.value = '';
  mention.value = null;
  savingState.value = 'saved';
  historyReady.value = true;
  writeBrowserValue(ACTIVE_CHAT_KEY, chat.id);
  applyingChat = false;
}

async function activateChat(chat: StoredChat): Promise<boolean> {
  let selected = chat;
  let requestedModel = chat.settings.modelSource === 'local' ? chat.settings.modelId : '';
  if (requestedModel && catalog.value) {
    const exists = catalog.value.models.some((model) => model.settings.id === requestedModel);
    if (!exists) {
      requestedModel = catalog.value.defaultActive || catalog.value.active;
      selected = { ...chat, settings: { ...chat.settings, modelId: requestedModel } };
      emit(
        'notify',
        `This chat's model is no longer in the catalogue; using ${requestedModel}.`,
        'error',
      );
    }
  }

  if (requestedModel && catalog.value?.active !== requestedModel) {
    switching.value = true;
    try {
      const response = await chatApi.useModel(requestedModel, false);
      catalog.value = response;
      status.value = response.status;
    } catch (error) {
      switching.value = false;
      emit('notify', (error as Error).message, 'error');
      return false;
    } finally {
      switching.value = false;
    }
  }

  applyStoredChat(selected);
  rememberSummary(summaryFromRecord(selected));
  if (selected.settings.modelId !== chat.settings.modelId) {
    void persistSettings(selected.id, selected.settings);
  }
  await scrollToBottom();
  return true;
}

function importToken(legacyRecord: string): string {
  const existing = readBrowserValue(LEGACY_IMPORT_KEY);
  if (existing) return existing;

  // Stable fallback also keeps the server import idempotent in sandboxed
  // browsers where localStorage is unavailable.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < legacyRecord.length; index += 1) {
    const code = legacyRecord.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  const token = `legacy-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}-${legacyRecord.length.toString(36)}`;
  writeBrowserValue(LEGACY_IMPORT_KEY, token);
  return token;
}

async function initialiseChatHistory(): Promise<void> {
  historyLoading.value = true;
  try {
    let list = (await chatsApi.list()).chats;
    let importedId = '';
    const legacy = readBrowserValue(LEGACY_STORAGE_KEY);
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as { turns?: unknown; settings?: unknown };
        const oldTurns = Array.isArray(parsed.turns) ? (parsed.turns as ChatTurn[]) : [];
        const oldSettings =
          typeof parsed.settings === 'object' && parsed.settings !== null
            ? (parsed.settings as Partial<ChatSettings>)
            : {};
        const hasOldConversation = oldTurns.length > 0 || Object.keys(oldSettings).length > 0;
        if (hasOldConversation) {
          const merged: ChatSettings = { ...defaultChatSettings(), ...oldSettings };
          if (!merged.modelId) merged.modelId = defaultChatSettings().modelId;
          if (!merged.styleName) merged.styleName = defaultChatSettings().styleName;
          const imported = await chatsApi.importLegacy({
            importId: importToken(legacy),
            title: 'Imported chat',
            settings: merged,
            turns: oldTurns,
          });
          importedId = imported.chat?.id ?? '';
        }
        // The server has acknowledged the idempotent import (or the record was empty).
        removeBrowserValue(LEGACY_STORAGE_KEY);
      } catch (error) {
        emit(
          'notify',
          `Could not import the old browser chat: ${(error as Error).message}`,
          'error',
        );
      }
      list = (await chatsApi.list()).chats;
    }

    chats.value = list;
    const preferred = readBrowserValue(ACTIVE_CHAT_KEY) ?? '';
    const selected =
      list.find((chat) => chat.id === preferred) ??
      list.find((chat) => chat.id === importedId) ??
      list[0];
    if (selected) {
      const response = await chatsApi.get(selected.id);
      if (!(await activateChat(response.chat))) return;
    } else {
      const created = await chatsApi.create({ settings: defaultChatSettings() });
      rememberSummary(summaryFromRecord(created.chat));
      if (!(await activateChat(created.chat))) return;
    }
  } catch (error) {
    emit(
      'notify',
      `Chat history could not be loaded from SQLite: ${(error as Error).message}`,
      'error',
    );
  } finally {
    historyLoading.value = false;
  }
}

async function selectChat(summary: ChatSummary): Promise<void> {
  confirmDeleteId.value = '';
  if (busy.value || switching.value || summary.id === activeChatId.value) return;
  if (!(await flushPersistence())) {
    emit('notify', 'The current chat could not be saved; it was not switched.', 'error');
    return;
  }
  try {
    const response = await chatsApi.get(summary.id);
    await activateChat(response.chat);
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function createNewChat(): Promise<void> {
  confirmDeleteId.value = '';
  if (busy.value || switching.value) return;
  if (!(await flushPersistence())) {
    emit('notify', 'The current chat could not be saved; a new chat was not created.', 'error');
    return;
  }
  try {
    const response = await chatsApi.create({ settings: defaultChatSettings() });
    rememberSummary(summaryFromRecord(response.chat));
    await activateChat(response.chat);
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

async function deleteChat(summary: ChatSummary): Promise<void> {
  if (busy.value || switching.value || deletingChat.value) return;
  if (confirmDeleteId.value !== summary.id) {
    confirmDeleteId.value = summary.id;
    return;
  }
  confirmDeleteId.value = '';
  deletingChat.value = true;
  try {
    if (summary.id === activeChatId.value && !(await flushPersistence())) {
      emit('notify', 'The chat could not be saved; it was not deleted.', 'error');
      return;
    }
    await chatsApi.remove(summary.id);
    forgetSummary(summary.id);
    if (summary.id === activeChatId.value) {
      historyReady.value = false;
      activeChatId.value = '';
      if (chats.value.length > 0) await selectChat(chats.value[0]!);
      else await createNewChat();
    }
    emit('notify', 'Chat deleted', 'success');
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  } finally {
    deletingChat.value = false;
  }
}

/* ── engine status ───────────────────────────────────────────────────────── */

const activeModel = computed<ModelRecord | null>(() =>
  settings.modelSource === 'local'
    ? (catalog.value?.models.find(
        (model) => model.settings.id === (settings.modelId || catalog.value?.active),
      ) ?? null)
    : null,
);

function formatSize(bytes: number): string {
  return bytes > 0 ? `${(bytes / 1048576).toFixed(0)} MB` : 'not downloaded';
}

async function loadModels(): Promise<void> {
  try {
    catalog.value = await chatApi.models();
    await loadStyles();
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
  }
}

/** Switch the model backing the chat; the weights load lazily. */
async function loadStyles(): Promise<void> {
  try {
    const catalogue = await promptsApi.list();
    styles.value = catalogue.prompts.map((entry) => ({
      name: entry.name,
      description: entry.description,
      prompt: entry.prompt,
    }));
    defaultStyleName.value = catalogue.active;
  } catch {
    // The picker stays empty; chat is unaffected and falls back to the plain prompt.
  }
}

function selectStyle(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  settings.styleName = value;
  emit(
    'notify',
    value ? `Thinking style for this chat: ${value}` : 'Thinking style: default',
    'success',
  );
}

async function selectLocalModel(id: string): Promise<void> {
  modelPicker.value = false;
  if (!id || (settings.modelSource === 'local' && id === settings.modelId)) return;

  switching.value = true;
  try {
    const response = await chatApi.useModel(id, false);
    catalog.value = response;
    status.value = response.status;
    settings.modelSource = 'local';
    settings.providerId = '';
    settings.modelId = id;
    if (!response.status.modelPresent) {
      emit(
        'notify',
        `${response.status.modelName} is selected for this chat — download its weights to chat`,
        'error',
      );
    } else {
      emit('notify', `This chat now uses ${response.status.modelName}`, 'success');
    }
  } catch (error) {
    emit('notify', (error as Error).message, 'error');
    await loadModels();
  } finally {
    switching.value = false;
  }
}

async function selectModel(event: Event): Promise<void> {
  await selectLocalModel((event.target as HTMLSelectElement).value);
}

function selectCloudModel(provider: CloudProvider, modelId: string): void {
  if (!provider.keyConfigured || !provider.models.some((model) => model.id === modelId)) return;
  settings.modelSource = 'cloud';
  mcpPicker.value = false;
  settings.providerId = provider.id;
  settings.modelId = modelId;
  modelPicker.value = false;
  emit('notify', `This chat now uses ${provider.name} · ${modelId}`, 'success');
}

async function loadCloudProviders(): Promise<void> {
  cloudProvidersLoading.value = true;
  try {
    const response = await cloudProvidersApi.list();
    cloudProviders.value = response.providers;
  } catch (error) {
    if (!cloudProvidersReady.value) {
      emit('notify', `Cloud model list could not be loaded: ${(error as Error).message}`, 'error');
    }
  } finally {
    cloudProvidersReady.value = true;
    cloudProvidersLoading.value = false;
  }
}

function toggleModelPicker(): void {
  modelPicker.value = !modelPicker.value;
  if (modelPicker.value) void loadCloudProviders();
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

const history = computed<ChatMessage[]>(() => chatHistoryFromTurns(turns.value));

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
      turn.plans = [];
      break;
    case 'plan':
      // The model's own one-liner for what this step is for.
      (turn.plans ??= []).push({ text: event.text, step: event.step });
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
        repairs: event.repairs,
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
  if (!text || busy.value || !historyReady.value || !activeChatId.value) return;

  // Snapshot prior turns before the new user turn enters the reactive transcript.
  // Otherwise the current message would be included twice in the API request.
  const priorHistory = history.value;
  const chatId = activeChatId.value;
  const turnSettings = currentSettings();
  const promptTemplate =
    styles.value.find((style) => style.name === settings.styleName)?.prompt ?? '';
  // Read the skills off the message itself, so what is sent matches what is on
  // screen — a mention deleted by hand is not attached.
  const pinned = attachedSkills(text, skillNames.value);
  const userTurn = newTurn('user');
  userTurn.text = text;
  if (pinned.length > 0) userTurn.skills = pinned;
  draft.value = '';
  mention.value = null;
  const assistant = newTurn('assistant');
  busy.value = true;
  startClock();
  await scrollToBottom();

  // A question reaches the model only after the selected chat's settings and
  // the question itself have reached SQLite. If storage is unavailable, keep
  // the text in the composer history instead of running an unrecorded turn.
  if (settingsSaveTimer !== null) window.clearTimeout(settingsSaveTimer);
  if (turnsSaveTimer !== null) window.clearTimeout(turnsSaveTimer);
  settingsSaveTimer = null;
  turnsSaveTimer = null;
  const [settingsSaved, turnsSaved] = await Promise.all([
    persistSettings(chatId, turnSettings),
    persistTurns(chatId, serialisedTurns()),
  ]);
  if (!settingsSaved || !turnsSaved) {
    turns.value.splice(-2, 2);
    busy.value = false;
    stopClock();
    draft.value = text;
    savingState.value = 'error';
    emit('notify', 'This chat could not be saved to SQLite, so the message was not sent.', 'error');
    return;
  }

  handle = streamChat({
    messages: [...priorHistory, { role: 'user', content: text }],
    modelSource: settings.modelSource,
    providerId: settings.providerId,
    modelId: settings.modelId,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    thinking: settings.thinking,
    tools: settings.modelSource === 'local' && settings.tools,
    net: settings.modelSource === 'local' && settings.net,
    systemPrompt: settings.systemPrompt,
    promptTemplate,
    maxToolIterations: settings.maxSteps,
    ...(pinned.length > 0 ? { skills: pinned } : {}),
    // Omitted when nothing is restricted, so the engine keeps offering every
    // enabled server (and any that connects later).
    ...(settings.modelSource === 'local' && settings.mcpServers !== null
      ? { mcpServers: [...selectedMcp.value] }
      : {}),
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
      scheduleTurnsSave();
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
  scheduleTurnsSave();
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
  // The completion list owns the keyboard while a `/word` is being typed:
  // Enter picks rather than sends, and Esc takes the mention back out.
  if (mention.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = mentionMatches.value.length;
      if (rows > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        mentionIndex.value = (mentionIndex.value + step + rows) % rows;
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && mentionOpen.value) {
      event.preventDefault();
      void pickSkill(mentionIndex.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void dropMentionWord();
      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

function promptPreview(): string {
  if (settings.modelSource === 'cloud') {
    return [
      `# Cloud chat (${selectedCloudProvider.value?.name ?? 'provider unavailable'})`,
      `model: ${selectedCloudModel.value?.id || settings.modelId || 'not selected'}`,
      'Inference runs through the provider API; local scripts, web tools and MCP are not executed.',
      `Attached skills: ${draftSkills.value.join(', ') || 'none for the current draft'}`,
    ].join(String.fromCharCode(10));
  }
  if (!config.value) return '';
  return [
    `# InfAgent chat (Qwen3-0.6B, ${status.value?.quantization ?? 'Q4_K_M'}, CPU only)`,
    '',
    `context : ${config.value.contextSize} tokens · threads ${config.value.threads}`,
    `scripts : ${config.value.scriptCount} exposed as tools`,
    `thinking: ${settings.thinking ? 'on' : 'off (default — a 0.6B model is much faster without it)'}`,
    `steps: ${settings.maxSteps} (tool calls → results → more calls, then the answer)`,
    `mcp   : ${mcpLabel.value}${mcpRestricted.value ? ` (${selectedMcp.value.join(', ') || 'none'})` : ''}`,
    `skills: ${draftSkills.value.join(', ') || 'none pinned by this message'}`,
    '',
    'The model runs entirely on this machine through llama.cpp.',
    `Model settings: ${status.value?.settingsFile ?? '—'}`,
    `Weights folder: ${status.value?.weightsDir ?? '—'}`,
    'Tool calls are `<tool_call>{"name": "...", "args": {...}}</tool_call>` blocks,',
    'executed against the same script folder as the Scripts tab.',
  ].join('\n');
}

/* ── skills: `/name` in the box ───────────────────────────────────────────── */

const skillNames = computed(() => skillList.value.map((skill) => skill.meta.name));

/** The rows to show: everything for a bare `/`, else the filtered names. */
const mentionMatches = computed(() => filterSkills(skillList.value, mention.value?.query ?? ''));

/** The list is open as soon as a `/word` is under the caret and something matches. */
const mentionOpen = computed(() => mention.value !== null && mentionMatches.value.length > 0);

/** The skills this message will attach, read straight from the text. */
const draftSkills = computed(() => attachedSkills(draft.value, skillNames.value));

async function loadSkills(): Promise<void> {
  try {
    const response = await skillsApi.list();
    skillList.value = response.skills;
  } catch {
    // No completions without the list; the box still works as plain text.
  }
}

/** Re-read the caret: the mention is wherever the user is typing, not the end. */
function syncMention(): void {
  const box = draftBox.value;
  if (!box) return;
  const next = mentionAt(draft.value, box.selectionStart ?? draft.value.length);
  if (next?.start !== mention.value?.start || next?.query !== mention.value?.query) {
    mentionIndex.value = 0;
  }
  mention.value = next;
}

/** Put the caret back after a line the list rewrote. */
async function focusBox(caret: number): Promise<void> {
  await nextTick();
  const box = draftBox.value;
  if (!box) return;
  box.focus();
  box.setSelectionRange(caret, caret);
  syncMention();
}

/** Use the highlighted skill (or row `index`, for a tap). */
async function pickSkill(index: number): Promise<void> {
  const current = mention.value;
  const option = mentionMatches.value[index];
  if (!current || !option) return;
  const edit = applyMention(draft.value, current, option.name);
  draft.value = edit.text;
  await focusBox(edit.caret);
}

/** Esc: take the `/` and the word back out, and leave the caret where it was. */
async function dropMentionWord(): Promise<void> {
  const current = mention.value;
  if (!current) return;
  const edit = dropMention(draft.value, current);
  draft.value = edit.text;
  await focusBox(edit.caret);
}

/* ── the 🔧 MCP picker ───────────────────────────────────────────────────── */

const enabledMcps = computed(() =>
  (mcpCatalogue.value?.servers ?? []).filter((server) => server.enabled),
);

/** Names the model may use for the next message (every enabled one by default). */
const selectedMcp = computed<string[]>(() => {
  const all = enabledMcps.value.map((server) => server.name);
  if (settings.mcpServers === null) return all;
  return all.filter((name) => settings.mcpServers?.includes(name) ?? false);
});

const mcpLabel = computed(() => {
  const total = enabledMcps.value.length;
  if (total === 0) return 'none connected';
  const chosen = selectedMcp.value.length;
  if (settings.mcpServers !== null && chosen === 0) return 'all off';
  if (settings.mcpServers === null || chosen === total) return `all ${total}`;
  return `${chosen}/${total}`;
});

const mcpRestricted = computed(
  () => enabledMcps.value.length > 0 && selectedMcp.value.length !== enabledMcps.value.length,
);

function toggleMcp(name: string): void {
  const chosen = new Set(selectedMcp.value);
  if (chosen.has(name)) chosen.delete(name);
  else chosen.add(name);
  // Every enabled server ticked is the same as "no restriction": store `null`,
  // so a server connected later is offered without coming back to this picker.
  const all = enabledMcps.value.map((server) => server.name);
  const next = all.filter((candidate) => chosen.has(candidate));
  settings.mcpServers = next.length === all.length ? null : next;
}

function setAllMcp(on: boolean): void {
  settings.mcpServers = on ? null : [];
}

async function loadMcp(): Promise<void> {
  try {
    mcpCatalogue.value = await mcpApi.list();
  } catch {
    // The picker keeps its last known list; chat is unaffected.
  }
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target as Node;
  if (mcpPicker.value && mcpWrap.value && !mcpWrap.value.contains(target)) {
    mcpPicker.value = false;
  }
  if (modelPicker.value && modelPickerWrap.value && !modelPickerWrap.value.contains(target)) {
    modelPicker.value = false;
  }
}

async function toggleMcpPicker(): Promise<void> {
  mcpPicker.value = !mcpPicker.value;
  if (mcpPicker.value) await loadMcp();
}

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  if (settingsSaveTimer !== null) window.clearTimeout(settingsSaveTimer);
  if (turnsSaveTimer !== null) window.clearTimeout(turnsSaveTimer);
  if (periodicRefresh !== null) window.clearInterval(periodicRefresh);
  void flushPersistence();
});

onMounted(async () => {
  document.addEventListener('click', onDocumentClick);
  void loadMcp();
  void loadSkills();
  await Promise.all([refresh(), loadModels(), loadCloudProviders()]);
  await initialiseChatHistory();
  periodicRefresh = window.setInterval(() => {
    void refresh();
    void loadMcp();
    void loadSkills();
    void loadCloudProviders();
    if (!switching.value) void loadModels();
  }, 20_000);
});
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-start">
    <div class="grid min-w-0 gap-4">
      <section class="card border border-base-300 bg-base-200/70">
        <div class="card-body gap-3 p-4">
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <span class="grid h-10 w-10 place-items-center rounded-xl bg-primary/15 text-lg"
                >🤖</span
              >
              <div>
                <h2 class="card-title text-base">
                  {{
                    settings.modelSource === 'cloud'
                      ? (selectedCloudModel?.name ?? settings.modelId ?? 'Cloud model')
                      : (status?.modelName ?? 'Qwen3 0.6B (Q4_K_M)')
                  }}
                  <span
                    v-if="settings.modelSource === 'local' && status?.quantization"
                    class="badge badge-sm badge-ghost font-mono"
                    >{{ status.quantization }}</span
                  >
                </h2>
                <p class="text-[11px] opacity-70">
                  <template v-if="settings.modelSource === 'cloud'">
                    cloud · {{ selectedCloudProvider?.name ?? 'provider unavailable' }} · hosted API
                  </template>
                  <template v-else>
                    local · CPU {{ status?.threads ?? config?.threads ?? 2 }} threads · ctx
                    {{ status?.contextSize ?? config?.contextSize ?? 0 }} · RAM
                    {{ status?.ramUsedMb ?? 0 }} MB
                  </template>
                </p>
                <p class="truncate text-[10px] text-primary/80">
                  {{
                    activeChat
                      ? `Chat: ${activeChat.title}`
                      : historyLoading
                        ? 'Loading chat history…'
                        : ''
                  }}
                </p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <select
                v-if="settings.modelSource === 'local' && catalog && catalog.models.length > 0"
                class="select select-bordered select-xs max-w-[13rem] font-mono"
                :value="settings.modelId || catalog.active"
                :disabled="switching || busy || !historyReady"
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

              <select
                v-if="styles.length > 0"
                class="select select-bordered select-xs max-w-[12rem]"
                :value="activeStyle"
                :disabled="busy || !historyReady"
                :title="
                  styles.find((style) => style.name === activeStyle)?.description ??
                  'How the model should think and answer'
                "
                aria-label="Thinking style"
                @change="selectStyle"
              >
                <option value="">default style</option>
                <option v-for="style in styles" :key="style.name" :value="style.name">
                  🧠 {{ style.name }}
                </option>
              </select>

              <label
                v-if="settings.modelSource === 'local'"
                class="flex items-center gap-1 text-[11px] text-base-content/70"
                title="Tool steps one reply may take: several calls, their results, then the answer"
              >
                steps
                <input
                  v-model.number="settings.maxSteps"
                  class="input input-bordered input-xs w-14 font-mono"
                  type="number"
                  min="1"
                  max="12"
                  step="1"
                  :disabled="busy"
                  aria-label="Max steps"
                />
              </label>

              <span
                v-if="settings.modelSource === 'local'"
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
              <span
                v-if="settings.modelSource === 'cloud'"
                class="badge badge-sm"
                :class="canChat ? 'badge-success' : 'badge-warning'"
                data-testid="cloud-model-status"
              >
                {{ canChat ? 'provider configured' : 'model or key needed' }}
              </span>

              <button
                v-if="
                  settings.modelSource === 'local' &&
                  (status?.state === 'absent' || (activeModel && !activeModel.present))
                "
                class="btn btn-primary btn-xs"
                :disabled="downloading"
                @click="download"
              >
                <span v-if="downloading" class="loading loading-spinner loading-xs" />
                {{
                  downloading
                    ? 'Downloading'
                    : `Download ${formatSize(activeModel?.sizeBytes ?? 0)}`
                }}
              </button>
              <button
                v-if="
                  settings.modelSource === 'local' &&
                  status?.modelPresent &&
                  status?.state === 'ready'
                "
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

          <div
            v-if="settings.modelSource === 'cloud' && historyReady && !canChat"
            class="alert alert-warning py-2 text-xs"
          >
            <span>
              This chat's cloud provider or model is unavailable. Open the model picker to choose
              another model, or configure a provider under Config → Cloud AI providers.
            </span>
          </div>

          <div
            v-if="settings.modelSource === 'local' && status?.state === 'downloading'"
            class="space-y-1"
          >
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

          <div
            v-if="settings.modelSource === 'local' && status?.state === 'absent'"
            class="alert py-2 text-xs"
          >
            <span>
              {{ status?.modelName ?? 'This model' }} ({{
                formatSize(activeModel?.sizeBytes ?? 0)
              }}, GGUF {{ status?.quantization || 'quantized' }} from Hugging Face) is not on this
              machine yet. Download it once — chat runs fully offline afterwards.
            </span>
          </div>

          <div
            v-if="
              settings.modelSource === 'local' &&
              (status?.state === 'unavailable' || status?.lastError)
            "
            class="alert alert-warning py-2 text-xs"
          >
            <span>{{
              status?.lastError ??
              'The local engine is unavailable. Run `npm install` to enable it.'
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
              <input
                v-model="settings.tools"
                type="checkbox"
                class="toggle toggle-sm"
                :disabled="settings.modelSource === 'cloud'"
              />
              Let the model call scripts as tools (local only)
            </label>
            <label class="flex items-center gap-2 text-xs">
              <input
                v-model="settings.net"
                type="checkbox"
                class="toggle toggle-sm"
                :disabled="settings.modelSource === 'cloud'"
              />
              Internet access (webSearch, webFetch; local only)
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

            <div
              class="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3 sm:col-span-2"
            >
              <button
                class="btn btn-ghost btn-xs"
                :disabled="!activeChatId || busy"
                title="Save this chat's settings to the server now"
                data-testid="save-settings"
                @click="saveCurrentSettings"
              >
                Save now
              </button>
              <span
                class="badge badge-sm"
                :class="{
                  'badge-success': savingState === 'saved',
                  'badge-warning': savingState === 'saving',
                  'badge-error': savingState === 'error',
                }"
                data-testid="chat-save-status"
              >
                {{ saveLabel }}
              </span>
              <span class="text-[11px] opacity-60">
                Settings apply to the next message and save automatically with this chat.
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
                {{
                  settings.modelSource === 'cloud'
                    ? 'Ask the selected cloud model anything.'
                    : 'Ask the on-device model anything — or let it run your scripts.'
                }}
              </p>
              <p class="max-w-md text-xs opacity-60">
                {{
                  settings.modelSource === 'cloud'
                    ? 'Choose another model at any time; this choice is saved per chat.'
                    : 'Try: “Use a tool to greet Amina”, “Which scripts do you have?”, or “Explain what DPDP means in one line.”'
                }}
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

                <div v-if="turn.skills && turn.skills.length > 0" class="mt-1 flex flex-wrap gap-1">
                  <span
                    v-for="name in turn.skills"
                    :key="name"
                    class="badge badge-sm gap-1 border-0 bg-base-100/30 font-mono text-[10px]"
                  >
                    📘 {{ name }}
                  </span>
                </div>
                <span v-else-if="turn.streaming" class="loading loading-dots loading-sm" />

                <ol
                  v-if="turn.plans && turn.plans.length > 0"
                  class="mt-1 space-y-0.5 text-[11px] text-base-content/60"
                >
                  <li v-for="(plan, index) in turn.plans" :key="index" class="truncate">
                    📋 {{ plan.step ? `step ${plan.step} ` : '' }}{{ plan.text }}
                  </li>
                </ol>

                <div
                  v-for="(call, index) in turn.calls"
                  :key="index"
                  class="mt-2 rounded-box border border-base-content/15 bg-base-100/20 p-2"
                >
                  <div class="flex items-center justify-between gap-2 text-[11px]">
                    <span class="font-mono"
                      >🛠 {{ call.name }}({{ JSON.stringify(call.args) }})</span
                    >
                    <span
                      class="badge badge-xs"
                      :class="
                        call.ok === false
                          ? 'badge-error'
                          : call.ok
                            ? 'badge-success'
                            : 'badge-ghost'
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
                  <template v-if="turn.stats.repairs">
                    · {{ turn.stats.repairs }} {{ turn.stats.repairs === 1 ? 'repair' : 'repairs' }}
                  </template>
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
            <!-- Per-chat local/cloud model choice, beside the MCP control. -->
            <div ref="modelPickerWrap" class="relative shrink-0 self-end">
              <button
                class="btn btn-sm max-w-[15rem] gap-1 px-2"
                :class="settings.modelSource === 'cloud' ? 'btn-primary' : 'btn-ghost'"
                :disabled="busy || switching || !historyReady"
                :title="`Model for this chat: ${selectedModelLabel}`"
                aria-label="Choose model for this chat"
                data-testid="model-picker"
                @click.stop="toggleModelPicker"
              >
                <span>🧠 Model</span>
                <span class="max-w-36 truncate text-[10px] opacity-80">{{
                  selectedModelLabel
                }}</span>
              </button>

              <div
                v-if="modelPicker"
                class="absolute bottom-full left-0 z-40 mb-2 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-box border border-base-300 bg-base-100 p-3 shadow-xl"
                data-testid="model-picker-panel"
                @click.stop
              >
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="text-xs font-semibold">Model for this chat</span>
                  <button class="btn btn-ghost btn-xs" @click="modelPicker = false">Close</button>
                </div>
                <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-55">
                  Downloaded local models
                </p>
                <p v-if="localModels.length === 0" class="px-2 py-1 text-[11px] opacity-60">
                  No downloaded local models. Download one from the Chat controls, or choose a cloud
                  model below.
                </p>
                <button
                  v-for="model in localModels"
                  :key="model.settings.id"
                  class="flex w-full items-center justify-between gap-2 rounded-box px-2 py-1.5 text-left hover:bg-base-200"
                  :class="
                    settings.modelSource === 'local' && settings.modelId === model.settings.id
                      ? 'bg-primary/15'
                      : ''
                  "
                  :data-testid="`model-local-${model.settings.id}`"
                  @click="selectLocalModel(model.settings.id)"
                >
                  <span class="min-w-0 truncate font-mono text-xs">{{ model.settings.id }}</span>
                  <span class="badge badge-success badge-xs shrink-0">{{
                    formatSize(model.sizeBytes ?? 0)
                  }}</span>
                </button>

                <div class="my-2 border-t border-base-300" />
                <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-55">
                  Configured cloud models
                </p>
                <p
                  v-if="cloudProvidersLoading"
                  class="flex items-center gap-2 px-2 py-2 text-[11px] opacity-60"
                >
                  <span class="loading loading-spinner loading-xs" /> Loading providers…
                </p>
                <template v-for="provider in cloudProviders" :key="provider.id">
                  <p class="mt-2 px-2 text-[11px] font-semibold">
                    ☁ {{ provider.name }}
                    <span class="font-normal opacity-55">{{
                      provider.keyConfigured ? '' : ' · API key needed'
                    }}</span>
                  </p>
                  <button
                    v-for="model in provider.models"
                    :key="`${provider.id}:${model.id}`"
                    class="flex w-full items-center justify-between gap-2 rounded-box px-2 py-1.5 text-left hover:bg-base-200 disabled:cursor-not-allowed disabled:opacity-40"
                    :class="
                      settings.modelSource === 'cloud' &&
                      settings.providerId === provider.id &&
                      settings.modelId === model.id
                        ? 'bg-primary/15'
                        : ''
                    "
                    :disabled="!provider.keyConfigured"
                    :data-testid="`model-cloud-${provider.id}-${model.id}`"
                    @click="selectCloudModel(provider, model.id)"
                  >
                    <span class="min-w-0 truncate font-mono text-xs">{{
                      model.name || model.id
                    }}</span>
                    <span
                      v-if="
                        settings.modelSource === 'cloud' &&
                        settings.providerId === provider.id &&
                        settings.modelId === model.id
                      "
                      class="badge badge-primary badge-xs shrink-0"
                      >selected</span
                    >
                  </button>
                  <p v-if="provider.models.length === 0" class="px-2 py-1 text-[10px] opacity-55">
                    No model IDs yet — test the provider or add IDs under Config.
                  </p>
                </template>
                <p
                  v-if="cloudProviders.length === 0 && !cloudProvidersLoading"
                  class="px-2 py-1 text-[11px] opacity-60"
                >
                  No cloud models configured. Add a provider under Config → Cloud AI providers.
                </p>
                <p class="mt-2 border-t border-base-300 pt-2 text-[10px] opacity-55">
                  Selection is saved to this chat. Cloud chats send messages to the configured
                  provider; local tool execution remains off.
                </p>
              </div>
            </div>

            <!-- Which MCP servers the local model may use: the wrench beside the box. -->
            <div
              v-if="settings.modelSource === 'local'"
              ref="mcpWrap"
              class="relative shrink-0 self-end"
            >
              <button
                class="btn btn-sm gap-1 px-2"
                :class="{ 'btn-primary': mcpRestricted, 'btn-ghost': !mcpRestricted }"
                :disabled="enabledMcps.length === 0 && !mcpCatalogue"
                :title="
                  settings.mcpServers === null
                    ? 'MCP servers: every connected server. Click to choose.'
                    : `MCP servers for this chat: ${selectedMcp.join(', ') || 'none'}`
                "
                data-testid="mcp-picker"
                @click.stop="toggleMcpPicker"
              >
                🔧<span class="font-mono text-[10px] opacity-80">{{ mcpLabel }}</span>
              </button>

              <div
                v-if="mcpPicker"
                class="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-box border border-base-300 bg-base-100 p-3 shadow-xl"
                data-testid="mcp-picker-panel"
                @click.stop
              >
                <div class="mb-2 flex items-center justify-between gap-2">
                  <span class="text-xs font-semibold">MCP servers for this chat</span>
                  <span class="flex gap-1">
                    <button
                      class="btn btn-ghost btn-xs"
                      data-testid="mcp-all"
                      @click="setAllMcp(true)"
                    >
                      All
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      data-testid="mcp-none"
                      @click="setAllMcp(false)"
                    >
                      None
                    </button>
                  </span>
                </div>

                <p v-if="enabledMcps.length === 0" class="text-[11px] opacity-70">
                  No MCP server is connected. Add or connect one in the 🔌 MCP tab — the choice here
                  takes effect on the next message.
                </p>

                <label
                  v-for="server in enabledMcps"
                  :key="server.name"
                  class="flex cursor-pointer items-center gap-2 rounded-box px-1 py-1 hover:bg-base-200"
                >
                  <input
                    type="checkbox"
                    class="checkbox checkbox-xs"
                    :checked="selectedMcp.includes(server.name)"
                    :data-testid="`mcp-pick-${server.name}`"
                    @change="toggleMcp(server.name)"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs">{{ server.name }}</span>
                    <span class="block truncate text-[10px] opacity-60">
                      {{ server.tools.length }} tool(s)
                      <template v-if="server.description">· {{ server.description }}</template>
                    </span>
                  </span>
                  <span
                    class="badge badge-xs"
                    :class="{
                      'badge-success': server.state === 'ready',
                      'badge-warning': server.state === 'starting',
                      'badge-error': server.state === 'error',
                      'badge-ghost': server.state === 'stopped',
                    }"
                    >{{ server.state }}</span
                  >
                </label>

                <p class="mt-2 border-t border-base-300 pt-2 text-[10px] opacity-60">
                  An unticked server is hidden from the model and its calls are refused. The choice
                  applies to the next message and saves automatically to this chat.
                </p>
              </div>
            </div>

            <div class="relative min-w-[12rem] flex-1">
              <!-- `/` completes to a skill; the selected ones load for this turn. -->
              <div
                v-if="mentionOpen"
                class="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-full max-w-lg overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-xl"
                data-testid="skill-menu"
              >
                <p class="px-2 py-1 text-[10px] opacity-60">
                  skill · ↑↓ move · ⏎ pick · Esc removes the /word ·
                  {{ mentionMatches.length }} match{{ mentionMatches.length === 1 ? '' : 'es' }}
                </p>
                <button
                  v-for="(option, index) in mentionMatches"
                  :key="option.name"
                  class="flex w-full items-start gap-2 rounded-box px-2 py-1 text-left"
                  :class="{ 'bg-primary/20': index === mentionIndex }"
                  :data-testid="`skill-option-${option.name}`"
                  @mouseenter="mentionIndex = index"
                  @mousedown.prevent
                  @click.prevent="pickSkill(index)"
                >
                  <span class="grid h-5 w-5 shrink-0 place-items-center text-xs">📘</span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-mono text-xs">/{{ option.name }}</span>
                    <span class="block truncate text-[10px] opacity-70">{{
                      option.description
                    }}</span>
                  </span>
                  <span
                    v-if="draftSkills.includes(option.name)"
                    class="badge badge-success badge-xs shrink-0"
                    >attached</span
                  >
                </button>
              </div>

              <textarea
                ref="draftBox"
                v-model="draft"
                rows="2"
                class="textarea textarea-bordered textarea-sm w-full"
                :placeholder="
                  canChat
                    ? settings.modelSource === 'cloud'
                      ? `Message ${selectedCloudProvider?.name ?? 'cloud model'}…  (Enter to send, Shift+Enter for a new line)`
                      : 'Message the on-device model…  (Enter to send, Shift+Enter for a new line, / for a skill)'
                    : settings.modelSource === 'cloud'
                      ? 'Choose a configured cloud model in Config'
                      : 'Load the local model first'
                "
                :disabled="busy"
                data-testid="draft"
                @keydown="onKeydown"
                @keyup="syncMention"
                @input="syncMention"
                @click="syncMention"
              ></textarea>
            </div>
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
            <template v-if="settings.modelSource === 'cloud'">
              Messages are sent to
              {{ selectedCloudProvider?.name ?? 'the selected cloud provider' }}; this chat does not
              execute local scripts or MCP tools.
            </template>
            <template v-else>
              Everything runs locally through llama.cpp — no API key, no data leaving the machine.
              <span v-if="settings.tools"> Tool calls execute scripts from the Scripts tab.</span>
            </template>
            <span v-if="draftSkills.length > 0" class="ml-1 text-base-content/70">
              Following {{ draftSkills.map((name) => `/${name}`).join(', ') }} —
              {{ draftSkills.length === 1 ? 'its steps are' : 'their steps are' }} loaded for this
              message.
            </span>
          </p>
        </div>
      </section>
    </div>

    <aside
      class="card border border-base-300 bg-base-200/70 xl:sticky xl:top-4"
      data-testid="chat-history"
    >
      <div class="card-body gap-3 p-3">
        <header class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="card-title text-sm">💬 Chat history</h2>
            <p class="text-[10px] opacity-60">Each chat keeps its own model, MCPs and settings.</p>
          </div>
          <button
            class="btn btn-primary btn-xs shrink-0"
            :disabled="historyLoading || busy || switching"
            data-testid="chat-new"
            @click="createNewChat"
          >
            ＋ New
          </button>
        </header>

        <input
          v-model="historyFilter"
          class="input input-bordered input-xs w-full"
          type="search"
          placeholder="Find a chat…"
          aria-label="Search chat history"
          data-testid="chat-search"
        />

        <div class="max-h-[68vh] min-h-24 space-y-1 overflow-y-auto pr-1">
          <div v-if="historyLoading" class="grid place-items-center py-8 text-xs opacity-60">
            <span class="loading loading-spinner loading-sm" /> Loading SQLite history…
          </div>
          <p
            v-else-if="filteredChats.length === 0"
            class="px-2 py-6 text-center text-xs opacity-60"
          >
            {{ historyFilter ? 'No chats match that search.' : 'No saved chats yet.' }}
          </p>

          <article
            v-for="chat in filteredChats"
            :key="chat.id"
            class="group flex items-stretch gap-1 rounded-box border border-transparent p-1"
            :class="
              chat.id === activeChatId ? 'border-primary/50 bg-primary/10' : 'hover:bg-base-300/50'
            "
            :data-testid="`chat-row-${chat.id}`"
          >
            <button
              class="min-w-0 flex-1 rounded-box px-2 py-1.5 text-left disabled:opacity-50"
              :disabled="busy || switching"
              :aria-current="chat.id === activeChatId ? 'page' : undefined"
              :data-testid="`chat-select-${chat.id}`"
              @click="selectChat(chat)"
            >
              <span class="flex items-center justify-between gap-2">
                <span class="truncate text-xs font-medium">{{ chat.title }}</span>
                <span class="shrink-0 text-[9px] opacity-50">{{ chat.turnCount }} turns</span>
              </span>
              <span class="mt-0.5 block truncate text-[10px] opacity-60">
                {{ chat.preview || 'Empty conversation' }}
              </span>
              <span class="mt-1 block truncate font-mono text-[9px] opacity-45">
                {{ chat.modelId || 'default model' }} · {{ chatUpdatedLabel(chat.updatedAt) }}
              </span>
            </button>
            <button
              class="btn btn-ghost btn-xs self-start text-error opacity-60 hover:opacity-100"
              :disabled="busy || switching || deletingChat"
              :aria-label="
                confirmDeleteId === chat.id
                  ? `Confirm delete ${chat.title}`
                  : `Delete ${chat.title}`
              "
              :title="
                confirmDeleteId === chat.id
                  ? 'Click again to permanently delete'
                  : `Delete ${chat.title}`
              "
              :data-testid="`chat-delete-${chat.id}`"
              @click.stop="deleteChat(chat)"
            >
              {{ confirmDeleteId === chat.id ? 'Delete?' : '×' }}
            </button>
          </article>
        </div>

        <p class="border-t border-base-300 pt-2 text-[10px] opacity-50">
          Stored in <code>chats.sqlite</code> on the server. Settings save automatically to the
          selected chat.
        </p>
      </div>
    </aside>
  </div>
</template>

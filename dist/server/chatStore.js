/**
 * Durable local storage for conversations and the settings that belong to each
 * one. The database is created in the user's application-data directory, not
 * in the checkout; it survives updates and is never committed with the repo.
 *
 * SQLite's write-ahead log with FULL synchronous writes is deliberate: chat
 * history is user data, and power loss should not silently discard it.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
export class ChatStoreError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.name = 'ChatStoreError';
        this.status = status;
    }
}
export const DEFAULT_CHAT_SETTINGS = {
    temperature: 0.4,
    maxTokens: 512,
    thinking: false,
    tools: true,
    net: true,
    systemPrompt: '',
    maxSteps: 6,
    mcpServers: null,
    modelId: '',
    styleName: '',
};
const SCHEMA_VERSION = 1;
const MAX_TURNS = 10_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TOOL_CALLS_PER_TURN = 256;
const MAX_PLANS_PER_TURN = 256;
/**
 * Use an OS-appropriate app-data folder. `INFAGENT_DATA_DIR` is useful for
 * portable installs and tests; `INFAGENT_DB_PATH` can name one exact file.
 */
export function defaultChatDatabasePath() {
    const exact = process.env['INFAGENT_DB_PATH']?.trim();
    if (exact)
        return resolve(exact);
    const customDir = process.env['INFAGENT_DATA_DIR']?.trim();
    if (customDir)
        return join(resolve(customDir), 'chats.sqlite');
    let directory;
    if (platform() === 'win32') {
        directory = join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'InfAgent');
    }
    else if (platform() === 'darwin') {
        directory = join(homedir(), 'Library', 'Application Support', 'InfAgent');
    }
    else {
        directory = join(process.env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share'), 'infagent');
    }
    return join(directory, 'chats.sqlite');
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function textField(value, name, fallback = '', max = MAX_TEXT_CHARS) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'string' || value.length > max) {
        throw new ChatStoreError(400, `Chat ${name} must be a string no longer than ${max} characters.`);
    }
    return value;
}
function boundedNumber(value, name, fallback, minimum, maximum, integer = false) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum ||
        (integer && !Number.isInteger(value))) {
        throw new ChatStoreError(400, `Chat ${name} must be between ${minimum} and ${maximum}.`);
    }
    return value;
}
function booleanField(value, name, fallback) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean')
        throw new ChatStoreError(400, `Chat ${name} must be true or false.`);
    return value;
}
/** Fill defaults for a legacy/partial settings object and bound untrusted input. */
export function normaliseChatSettings(value) {
    if (!isObject(value))
        throw new ChatStoreError(400, 'Chat settings must be a JSON object.');
    const fallback = DEFAULT_CHAT_SETTINGS;
    let mcpServers = fallback.mcpServers;
    if (value['mcpServers'] === null)
        mcpServers = null;
    else if (value['mcpServers'] !== undefined) {
        if (!Array.isArray(value['mcpServers']) || value['mcpServers'].length > 64) {
            throw new ChatStoreError(400, 'Chat MCP selection must be null or a list of up to 64 names.');
        }
        mcpServers = [
            ...new Set(value['mcpServers'].map((name) => {
                if (typeof name !== 'string' || name.length > 128 || !name.trim()) {
                    throw new ChatStoreError(400, 'Chat MCP server names must be non-empty strings.');
                }
                return name.trim();
            })),
        ];
    }
    return {
        temperature: boundedNumber(value['temperature'], 'temperature', fallback.temperature, 0, 2),
        maxTokens: boundedNumber(value['maxTokens'], 'maxTokens', fallback.maxTokens, 1, 8192, true),
        thinking: booleanField(value['thinking'], 'thinking', fallback.thinking),
        tools: booleanField(value['tools'], 'tools', fallback.tools),
        net: booleanField(value['net'], 'net', fallback.net),
        systemPrompt: textField(value['systemPrompt'], 'system prompt', fallback.systemPrompt, 40_000),
        maxSteps: boundedNumber(value['maxSteps'], 'maxSteps', fallback.maxSteps, 1, 12, true),
        mcpServers,
        modelId: textField(value['modelId'], 'model id', fallback.modelId, 128),
        styleName: textField(value['styleName'], 'style name', fallback.styleName, 128),
    };
}
function normaliseCall(value) {
    if (!isObject(value) || typeof value['name'] !== 'string' || !value['name'].trim())
        return null;
    const args = isObject(value['args']) ? value['args'] : {};
    const call = { name: value['name'].slice(0, 256), args };
    if (typeof value['ok'] === 'boolean')
        call['ok'] = value['ok'];
    if (Object.hasOwn(value, 'result'))
        call['result'] = value['result'];
    if (typeof value['error'] === 'string')
        call['error'] = value['error'].slice(0, MAX_TEXT_CHARS);
    if (typeof value['durationMs'] === 'number' && Number.isFinite(value['durationMs'])) {
        call['durationMs'] = Math.max(0, value['durationMs']);
    }
    return call;
}
function normaliseTurn(value, index) {
    if (!isObject(value))
        throw new ChatStoreError(400, `Chat turn ${index + 1} must be an object.`);
    const role = value['role'];
    if (role !== 'user' && role !== 'assistant') {
        throw new ChatStoreError(400, `Chat turn ${index + 1} has an unknown role.`);
    }
    const text = textField(value['text'], `turn ${index + 1} text`);
    const thinking = textField(value['thinking'], `turn ${index + 1} reasoning`);
    const id = textField(value['id'], `turn ${index + 1} id`, `turn-${index}`, 256);
    const callsRaw = value['calls'] === undefined ? [] : value['calls'];
    if (!Array.isArray(callsRaw) || callsRaw.length > MAX_TOOL_CALLS_PER_TURN) {
        throw new ChatStoreError(400, `Chat turn ${index + 1} has too many tool calls.`);
    }
    const calls = callsRaw
        .map(normaliseCall)
        .filter((call) => call !== null);
    const turn = { id, role, text, thinking, calls, streaming: false };
    if (Array.isArray(value['plans'])) {
        if (value['plans'].length > MAX_PLANS_PER_TURN) {
            throw new ChatStoreError(400, `Chat turn ${index + 1} has too many plan lines.`);
        }
        turn.plans = value['plans']
            .filter(isObject)
            .filter((plan) => typeof plan['text'] === 'string')
            .map((plan) => ({
            text: plan['text'].slice(0, 2048),
            ...(typeof plan['step'] === 'number' && Number.isInteger(plan['step'])
                ? { step: plan['step'] }
                : {}),
        }));
    }
    if (Array.isArray(value['skills'])) {
        turn.skills = value['skills']
            .filter((skill) => typeof skill === 'string')
            .slice(0, 32)
            .map((skill) => skill.slice(0, 128));
    }
    if (isObject(value['stats'])) {
        const stats = value['stats'];
        const totalTokens = stats['totalTokens'];
        const tokensPerSecond = stats['tokensPerSecond'];
        const durationMs = stats['durationMs'];
        if (typeof totalTokens === 'number' &&
            Number.isFinite(totalTokens) &&
            typeof tokensPerSecond === 'number' &&
            Number.isFinite(tokensPerSecond) &&
            typeof durationMs === 'number' &&
            Number.isFinite(durationMs)) {
            turn.stats = {
                totalTokens,
                tokensPerSecond,
                durationMs,
                ...(typeof stats['repairs'] === 'number' && Number.isFinite(stats['repairs'])
                    ? { repairs: stats['repairs'] }
                    : {}),
            };
        }
    }
    if (typeof value['error'] === 'string')
        turn.error = value['error'].slice(0, MAX_TEXT_CHARS);
    else if (value['streaming'] === true && role === 'assistant') {
        turn.error =
            'Generation was interrupted before this turn finished; its partial stream was not resumed.';
    }
    return turn;
}
export function normaliseChatTurns(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > MAX_TURNS) {
        throw new ChatStoreError(400, `Chat turns must be a list of no more than ${MAX_TURNS} entries.`);
    }
    return value.map(normaliseTurn);
}
function titleFromText(text) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean)
        return 'New chat';
    return clean.length > 72 ? `${clean.slice(0, 69).trimEnd()}…` : clean;
}
function previewFromTurns(turns) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const text = turns[index]?.text.trim();
        if (text)
            return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
    }
    return '';
}
function parseTimestamp(value) {
    return new Date(value).toISOString();
}
/** SQLite-backed conversation catalogue. Safe to instantiate with `:memory:` in tests. */
export class ChatStore {
    path;
    db;
    closed = false;
    constructor(path = defaultChatDatabasePath()) {
        this.path = path === ':memory:' ? path : resolve(path);
        if (this.path !== ':memory:') {
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        }
        this.db = new Database(this.path);
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = FULL');
        this.migrate();
        if (this.path !== ':memory:' && platform() !== 'win32') {
            try {
                chmodSync(this.path, 0o600);
            }
            catch {
                // A restrictive data directory still protects the database on filesystems
                // where chmod is unavailable.
            }
        }
    }
    migrate() {
        const version = this.db.pragma('user_version', { simple: true });
        if (version > SCHEMA_VERSION) {
            throw new Error(`Chat database schema ${version} is newer than this InfAgent supports.`);
        }
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        turn_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id TEXT PRIMARY KEY NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_turns (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        turn_json TEXT NOT NULL,
        PRIMARY KEY (chat_id, position)
      );
      CREATE INDEX IF NOT EXISTS chats_updated_at ON chats(updated_at DESC);
      CREATE TABLE IF NOT EXISTS legacy_imports (
        import_id TEXT PRIMARY KEY NOT NULL,
        chat_id TEXT NOT NULL,
        imported_at INTEGER NOT NULL
      );
    `);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
    insertChat(title, settings, turns) {
        const id = randomUUID();
        const now = Date.now();
        const firstUser = turns.find((turn) => turn.role === 'user' && turn.text.trim());
        const actualTitle = title === 'New chat' && firstUser ? titleFromText(firstUser.text) : title;
        const insertChat = this.db.prepare('INSERT INTO chats (id, title, created_at, updated_at, preview, turn_count) VALUES (?, ?, ?, ?, ?, ?)');
        insertChat.run(id, actualTitle, now, now, previewFromTurns(turns), turns.length);
        this.db
            .prepare('INSERT INTO chat_settings (chat_id, settings_json) VALUES (?, ?)')
            .run(id, JSON.stringify(settings));
        const insertTurn = this.db.prepare('INSERT INTO chat_turns (chat_id, position, turn_json) VALUES (?, ?, ?)');
        turns.forEach((turn, position) => insertTurn.run(id, position, JSON.stringify(turn)));
        return id;
    }
    summary(row) {
        let settings;
        try {
            settings = normaliseChatSettings(JSON.parse(String(row['settings_json'] ?? '{}')));
        }
        catch {
            settings = { ...DEFAULT_CHAT_SETTINGS };
        }
        return {
            id: String(row['id']),
            title: String(row['title']),
            createdAt: parseTimestamp(Number(row['created_at'])),
            updatedAt: parseTimestamp(Number(row['updated_at'])),
            preview: String(row['preview'] ?? ''),
            turnCount: Number(row['turn_count'] ?? 0),
            modelId: settings.modelId,
        };
    }
    summaryRows() {
        return this.db
            .prepare(`SELECT c.id, c.title, c.created_at, c.updated_at, c.preview, c.turn_count,
                s.settings_json
           FROM chats c JOIN chat_settings s ON s.chat_id = c.id
          ORDER BY c.updated_at DESC, c.created_at DESC, c.rowid DESC`)
            .all();
    }
    list() {
        return this.summaryRows().map((row) => this.summary(row));
    }
    getSummary(id) {
        const row = this.db
            .prepare(`SELECT c.id, c.title, c.created_at, c.updated_at, c.preview, c.turn_count,
                s.settings_json
           FROM chats c JOIN chat_settings s ON s.chat_id = c.id
          WHERE c.id = ?`)
            .get(id);
        return row ? this.summary(row) : null;
    }
    get(id) {
        const row = this.db
            .prepare(`SELECT c.id, c.title, c.created_at, c.updated_at, c.preview, c.turn_count,
                s.settings_json
           FROM chats c JOIN chat_settings s ON s.chat_id = c.id
          WHERE c.id = ?`)
            .get(id);
        if (!row)
            return null;
        const summary = this.summary(row);
        let settings = { ...DEFAULT_CHAT_SETTINGS };
        try {
            settings = normaliseChatSettings(JSON.parse(String(row['settings_json'])));
        }
        catch {
            // A bad row should not hide the rest of the conversation.
        }
        const turnRows = this.db
            .prepare('SELECT turn_json FROM chat_turns WHERE chat_id = ? ORDER BY position ASC')
            .all(id);
        const turns = turnRows.flatMap((turn, index) => {
            try {
                return [normaliseTurn(JSON.parse(turn.turn_json), index)];
            }
            catch {
                return [];
            }
        });
        return { ...summary, settings, turns };
    }
    create(input) {
        const title = textField(input.title, 'title', 'New chat', 120).trim() || 'New chat';
        const settings = normaliseChatSettings(input.settings);
        const turns = normaliseChatTurns(input.turns);
        const id = this.db.transaction(() => this.insertChat(title, settings, turns))();
        const chat = this.get(id);
        if (!chat)
            throw new Error('New chat disappeared from the database.');
        return chat;
    }
    importLegacy(input) {
        const importId = textField(input.importId, 'import id', '', 128).trim();
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(importId)) {
            throw new ChatStoreError(400, 'Legacy import id must be a 16–128 character token.');
        }
        const title = textField(input.title, 'title', 'Imported chat', 120).trim() || 'Imported chat';
        const settings = normaliseChatSettings(input.settings);
        const turns = normaliseChatTurns(input.turns);
        const result = this.db.transaction(() => {
            const prior = this.db
                .prepare('SELECT chat_id FROM legacy_imports WHERE import_id = ?')
                .get(importId);
            if (prior)
                return { chatId: prior.chat_id, created: false };
            const chatId = this.insertChat(title, settings, turns);
            this.db
                .prepare('INSERT INTO legacy_imports (import_id, chat_id, imported_at) VALUES (?, ?, ?)')
                .run(importId, chatId, Date.now());
            return { chatId, created: true };
        })();
        return { chat: this.get(result.chatId), created: result.created };
    }
    updateSettings(id, value) {
        const settings = normaliseChatSettings(value);
        const update = this.db.transaction(() => {
            const existing = this.db.prepare('SELECT id FROM chats WHERE id = ?').get(id);
            if (!existing)
                return false;
            this.db
                .prepare('UPDATE chat_settings SET settings_json = ? WHERE chat_id = ?')
                .run(JSON.stringify(settings), id);
            this.db
                .prepare('UPDATE chats SET updated_at = MAX(?, updated_at + 1) WHERE id = ?')
                .run(Date.now(), id);
            return true;
        })();
        return update ? this.get(id) : null;
    }
    updateTitle(id, value) {
        const title = textField(value, 'title', '', 120).trim();
        if (!title)
            throw new ChatStoreError(400, 'Chat title cannot be empty.');
        const result = this.db
            .prepare('UPDATE chats SET title = ?, updated_at = MAX(?, updated_at + 1) WHERE id = ?')
            .run(title, Date.now(), id);
        return result.changes > 0 ? this.get(id) : null;
    }
    saveTurns(id, value) {
        const turns = normaliseChatTurns(value);
        const save = this.db.transaction(() => {
            const existing = this.db.prepare('SELECT title FROM chats WHERE id = ?').get(id);
            if (!existing)
                return false;
            this.db.prepare('DELETE FROM chat_turns WHERE chat_id = ?').run(id);
            const insert = this.db.prepare('INSERT INTO chat_turns (chat_id, position, turn_json) VALUES (?, ?, ?)');
            turns.forEach((turn, position) => insert.run(id, position, JSON.stringify(turn)));
            const firstUser = turns.find((turn) => turn.role === 'user' && turn.text.trim());
            const title = existing.title === 'New chat' && firstUser ? titleFromText(firstUser.text) : existing.title;
            this.db
                .prepare('UPDATE chats SET title = ?, updated_at = MAX(?, updated_at + 1), preview = ?, turn_count = ? WHERE id = ?')
                .run(title, Date.now(), previewFromTurns(turns), turns.length, id);
            return true;
        })();
        return save ? this.get(id) : null;
    }
    delete(id) {
        return this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        this.db.close();
    }
}
//# sourceMappingURL=chatStore.js.map
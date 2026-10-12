/**
 * Toolbox — user JavaScript tool files, served as MCP tools.
 *
 * A file under the configured root exports its tools:
 *
 *   export default [
 *     { name: 'greet', description: 'Greet someone.', callback: ({ who }) => `Hello ${who}` },
 *   ];
 *
 * This server imports every such file (ES modules — the repo is
 * `"type": "module"`), validates the default export, and registers each entry
 * as a tool. Because the tool list comes from files, the list is resolved on
 * demand: `tools/list` re-checks modification times, a changed file is
 * re-imported, and `notifications/tools/list_changed` tells the client so the
 * chat picks the new tools up without a restart.
 *
 * The trust model, in one line: a tool file is code *you* installed and it runs
 * with this process's privileges. It is not a sandbox — for code the model
 * wrote, use the `code` server (`mcp/servers/code.mjs`), which does sandbox it.
 * What this server does enforce is where files may live (the configured root,
 * symlink-resolved), how big they and their output may be, and how long a call
 * may take.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PathPolicy } from '../lib/guards.mjs';
import { ToolError, configFromArgv, serve } from '../lib/protocol.mjs';

/** `mcp/tools/hello.js` → `hello.js`, for messages that stay readable. */
const DEFAULT_CONFIG = {
  root: 'mcp/tools',
  max_tools: 24,
  max_result_bytes: 65536,
  timeout_ms: 5000,
  cache: true,
};

const MAX_FILES = 32;
const MAX_FILE_BYTES = 65536;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{1,40}$/;
/** Names this server answers to itself; a tool file may not take them. */
const RESERVED = new Set(['tool_files', 'reload_tools']);
const EXTENSIONS = new Set(['.js', '.mjs']);

const config = { ...DEFAULT_CONFIG, ...configFromArgv() };
const maxTools = Number(config.max_tools) || DEFAULT_CONFIG.max_tools;
const maxResultBytes = Number(config.max_result_bytes) || DEFAULT_CONFIG.max_result_bytes;
const timeoutMs = Number(config.timeout_ms) || DEFAULT_CONFIG.timeout_ms;

let policy;
try {
  policy = new PathPolicy({ roots: [config.root] });
} catch (error) {
  throw new ToolError(`The toolbox root is unusable: ${error.message}`);
}
const root = policy.roots[0];

/** The state a load produces: what is callable, and what was refused where. */
let state = {
  tools: [],
  files: [],
  refused: [],
  loadedAt: new Date().toISOString(),
};

function rel(file) {
  return relative(process.cwd(), file) || file;
}

/** Every tool file under the root, newest check last — sorted and bounded. */
function discover() {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new ToolError(`Could not read ${rel(root)}: ${error.message}`);
  }

  const visible = entries.filter(
    (entry) => !entry.name.startsWith('.') && EXTENSIONS.has(extname(entry.name).toLowerCase()),
  );
  // A symlink is never followed: the file it points at is not in this folder,
  // and its content is not what the folder says it is. Reported, because a
  // silently ignored file looks like a broken tool file.
  const links = visible
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => `${join(rel(root), entry.name)} is a symlink; tool files are not followed`);
  const files = visible
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  if (files.length > MAX_FILES) {
    throw new ToolError(
      `${rel(root)} holds ${files.length} tool files; at most ${MAX_FILES} are loaded.`,
    );
  }

  const resolved = [];
  const refused = [...links];
  for (const name of files) {
    try {
      resolved.push(policy.resolvePath(join(root, name)));
    } catch (error) {
      // One unusable file (a symlink out of the root, say) is reported with the
      // others' results, never as a server that will not start.
      refused.push(`${join(rel(root), name)}: ${error.message}`);
    }
  }

  return { files: resolved, refused };
}

/** Values a callback may return that `JSON.stringify` refuses or mangles. */
function safeValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'bigint') return value.toString();
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (depth > 24) return '[too deep]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => safeValue(item, seen, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = safeValue(item, seen, depth + 1);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return String(value);
}

/** A callback's return value as the text the model will read. */
function rendered(value) {
  if (typeof value === 'string') return capText(value);
  const json = JSON.stringify(safeValue(value) ?? null, null, 2);
  return capText(json);
}

function capText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxResultBytes) return text;
  const kept = Buffer.from(text, 'utf8').subarray(0, maxResultBytes).toString('utf8');
  return `${kept}\n… (truncated: ${bytes - maxResultBytes} more bytes)`;
}

/** Validate one `{name, description, callback}` entry against the registry. */
function toTool(entry, file, taken) {
  if (!entry || typeof entry !== 'object') {
    return { problem: 'every entry must be an object' };
  }
  const { name, description, callback, inputSchema } = entry;
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return { problem: `\`${String(name)}\` is not a tool name (lower_case, 2-41 chars)` };
  }
  if (RESERVED.has(name)) return { problem: `\`${name}\` is this server's own tool` };
  if (taken.has(name)) return { problem: `\`${name}\` is already defined by ${taken.get(name)}` };
  if (typeof callback !== 'function') return { problem: `\`${name}\` has no callback function` };

  return {
    tool: {
      name,
      description: typeof description === 'string' && description.trim() ? description.trim() : `Tool ${name}.`,
      inputSchema:
        inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
          ? inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
      file,
      callback,
    },
  };
}

/** Import one file and turn its default export into tools. */
async function loadFile(file, taken) {
  const stat = statSync(file);
  if (stat.size > MAX_FILE_BYTES) {
    return { refused: [`${rel(file)} is ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}`] };
  }

  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let module;
  try {
    // The mtime in the query defeats the import cache: an edited file is
    // re-read without restarting the server.
    module = await import(`${pathToFileURL(file).href}?v=${stat.mtimeMs}`);
  } catch (error) {
    return { refused: [`${rel(file)} could not be imported: ${error.message}`] };
  }

  const entries = module.default ?? module.tools;
  if (!Array.isArray(entries)) {
    return {
      refused: [`${rel(file)} must \`export default\` an array of {name, description, callback}`],
    };
  }

  const tools = [];
  const refused = [];
  for (const entry of entries) {
    const { tool, problem } = toTool(entry, file, taken);
    if (!tool) {
      refused.push(`${rel(file)}: ${problem}`);
      continue;
    }
    if (taken.size >= maxTools) {
      refused.push(`${rel(file)}: \`${tool.name}\` not loaded — the ${maxTools}-tool limit is reached`);
      continue;
    }
    taken.set(tool.name, rel(file));
    tools.push(tool);
  }

  return { file: rel(file), mtime: new Date(stat.mtimeMs).toISOString(), sha256, tools, refused };
}

/** Read every tool file; nothing throws, so one bad file cannot sink the rest. */
async function build() {
  const files = [];
  const taken = new Map();
  const tools = [];
  const discovered = discover();
  const refused = [...discovered.refused];

  for (const file of discovered.files) {
    const outcome = await loadFile(file, taken);
    if (!outcome.file) {
      // An empty `refused` array is truthy: a file that loaded is the one with
      // a path, and only a file that did not is pushed as a refusal.
      refused.push(...(outcome.refused ?? []));
      continue;
    }
    files.push({
      file: outcome.file,
      mtime: outcome.mtime,
      sha256: outcome.sha256,
      tools: outcome.tools.map((tool) => tool.name),
    });
    refused.push(...(outcome.refused ?? []));
    tools.push(...outcome.tools);
  }

  return { tools, files, refused, loadedAt: new Date().toISOString() };
}

/** What changed between two loads, for `reload_tools` to report. */
function diff(before, after) {
  const was = new Set(before.tools.map((tool) => tool.name));
  const now = new Set(after.tools.map((tool) => tool.name));
  return {
    added: [...now].filter((name) => !was.has(name)),
    removed: [...was].filter((name) => !now.has(name)),
    still: [...now].filter((name) => was.has(name)),
  };
}

/**
 * Reload, if anything on disk changed (or `force`).
 *
 * Called before every `tools/list` and by `reload_tools`; it only touches files
 * whose size or mtime moved, so the steady-state cost is a handful of `stat`s.
 */
async function refresh({ force = false } = {}) {
  let changed = force;
  if (!changed) {
    try {
      const seen = new Set();
      for (const file of discover().files) {
        const stat = statSync(file);
        const known = state.files.find((entry) => entry.file === rel(file));
        seen.add(rel(file));
        if (!known || known.mtime !== new Date(stat.mtimeMs).toISOString()) changed = true;
      }
      if (!changed && seen.size !== state.files.length) changed = true;
    } catch {
      changed = true; // A root that just broke still has to report itself.
    }
  }

  if (!changed) return { ...diff(state, state), changed: false };

  const before = state;
  state = await build();
  const summary = { ...diff(before, state), changed: true };
  writeCache();
  return summary;
}

/** The registry on disk, for the console and for reading without a server. */
function writeCache() {
  if (config.cache === false) return;
  try {
    writeFileSync(
      join(root, '.cache.json'),
      `${JSON.stringify(
        {
          updated_at: state.loadedAt,
          root: rel(root),
          files: state.files,
          refused: state.refused,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    // A read-only root is a reason to skip the cache, not to fail a call.
  }
}

/** Run one callback with the time limit and the JSON-safe result handling. */
async function run(tool, args, context) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError(`\`${tool.name}\` did not answer within ${timeoutMs} ms.`)),
      timeoutMs,
    );
  });

  const call = Promise.resolve().then(() =>
    tool.callback(args ?? {}, { ...context, file: tool.file, tool: tool.name }),
  );
  // A callback that fails after the time limit must not become an unhandled
  // rejection once the race has already been lost.
  call.catch(() => {});

  try {
    const value = await Promise.race([call, limit]);
    return value === undefined ? null : value;
  } finally {
    clearTimeout(timer);
  }
}

const serverTools = [
  {
    name: 'tool_files',
    description:
      'List the loaded tool files: the file, its sha256 and mtime, the tool names it defines, and anything that was refused. Every listed tool is callable in this same server.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      await refresh();
      return {
        root: rel(root),
        loaded_at: state.loadedAt,
        files: state.files,
        refused: state.refused,
        tools: state.tools.map((tool) => tool.name),
      };
    },
  },
  {
    name: 'reload_tools',
    description:
      'Re-read the tool files from disk after they changed (or force a full reload) and report what was added and removed. New tools are callable immediately.',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Reload even if nothing changed.' } },
    },
    handler: async ({ force }, { notify }) => {
      const before = state.tools.map((tool) => tool.name);
      const summary = await refresh({ force: force === true });
      const after = state.tools.map((tool) => tool.name);
      const added = after.filter((name) => !before.includes(name));
      const removed = before.filter((name) => !after.includes(name));
      if (added.length > 0 || removed.length > 0) {
        notify('notifications/tools/list_changed');
      }
      return {
        root: rel(root),
        changed: summary.changed || added.length + removed.length > 0,
        added,
        removed,
        tools: after,
        previous: before,
        refused: state.refused,
      };
    },
  },
];

/** The tool list as the client asks for it — user tools plus this server's own. */
async function list(reason) {
  // Only `tools/list` re-reads the files: a call is a lookup, and `reload_tools`
  // must still be able to report the change it made.
  if (reason === 'list') await refresh();
  return [
    ...serverTools,
    ...state.tools.map((tool) => ({
      name: tool.name,
      description: `${tool.description} (from ${tool.file})`,
      inputSchema: tool.inputSchema,
      // The value is serialised and capped here: the protocol kit sends a
      // string as-is, and a callback's object must not reach the model as
      // `[object Object]` or as 40 MB of JSON.
      handler: async (args, context) => rendered(await run(tool, args, context)),
    })),
  ];
}

// Attached to stdin immediately: the first `tools/list` does the loading, and
// a root that turns out to be unreadable answers with the reason instead of
// leaving the client waiting.
serve({ name: 'infagent-toolbox', version: '1.0.0', tools: list });

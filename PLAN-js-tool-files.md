# Plan — JavaScript tool files (`export default [{name, description, callback}]`)

**Task 22 (proposed).** A user writes one JavaScript file that exports its own tools; an MCP
server imports that file, takes the default export, and puts those tools into the model's
context so the chat can call them like any other tool.

Status: **plan only, nothing written yet.** Say "apply" (with any changes) and it gets built.

---

## 1. What the request means, and the two readings of "save it in context"

The file:

```js
// mcp/tools/hello.js   ← the repo is `"type": "module"`, so plain .js works
export default [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    callback: ({ who }) => ({ greeting: `Hello ${who}` }),
  },
  { name: 'now', description: 'Current time as ISO.', callback: () => new Date().toISOString() },
];
```

The server (`mcp/servers/toolbox.mjs`) walks every file under its configured root, `import()`s
it, takes the **default export**, validates it, and registers each entry as an MCP tool named
`toolbox__<name>`:

- **"…and save it in context" — reading A (what I will build):** those tools are handed to the
  model in the system prompt on every turn. The pipeline already does this for MCP servers: the
  console lists `toolbox__greet` with its arguments (round-robin tool budget), the grammar
  offers it, and a call returns the callback's value as the tool result. Nothing new is needed
  in `src/chat/` — that is the whole point of reusing the MCP path.
- **Reading B (also built, cheap):** a *registry* of what was loaded — file, tool names,
  mtime, sha256 — kept in the server and exposed as `toolbox__tool_files`, plus written to
  `mcp/tools/.cache.json` (gitignored) so the console can show the toolbox without the server
  running. Say the word and B is dropped; A is the part that makes tools callable.

## 2. Decisions I need from you

| Fork | Recommendation |
| --- | --- |
| Where tool files live | **`mcp/tools/`** (new folder, ships with an example). The top-level `tools/` is already the dev-scripts folder; `scripts/` is the agent's own scripts. Configurable via `"root"` in `mcp.json`. |
| Isolation of a callback | **in-process for v1**, with a documented caveat; `isolation: "worker"` as a later phase. A callback is code *you* installed, like a `scripts/` script — it is not sandboxed the way model-written code in `code.mjs` is. A worker thread would give a hard per-call timeout and keep a blocking loop from freezing the server, at ~30–60 ms per call. |

## 3. Scope

**New files**

- `mcp/servers/toolbox.mjs` — the server: discovery, validation, registration, `tools/call`
  dispatch, `reload_tools`, `tool_files`. Built on the existing kit (`mcp/lib/protocol.mjs`)
  and `PathPolicy` (`mcp/lib/guards.mjs`) for root confinement.
- `mcp/tools/hello.js` — the worked example above (also the test fixture, copied to a tmpdir).
- `mcp/tools/package.json` — `{"type":"module","private":true}`, so a stray parent
  `package.json` can never turn a tool file into CommonJS.
- `tests/toolbox-mcp.test.ts` — see §5.
- `mcp/tools/README.md` — two paragraphs: the shape of the file, and the trust model.

**Edited files**

- `mcp.json` — eighth server:
  ```json
  "toolbox": {
    "command": "node",
    "args": ["mcp/servers/toolbox.mjs",
             "{\"root\":\"mcp/tools\",\"max_tools\":24,\"max_result_bytes\":65536,\"timeout_ms\":5000}"],
    "enabled": true,
    "description": "Tool files — a JS module's default export ([{name, description, callback}]) becomes callable tools in the chat."
  }
  ```
- `README.md` — a "Your own tools in JavaScript" section next to the code-sandbox one, and the
  server table gains a row.
- `.gitignore` — `mcp/tools/.cache.json`.

**Deliberately not touched:** `src/chat/**` (the MCP path already works), `scripts/` (a
different mechanism with a different contract — JSON argv, agent-authored), `code.mjs` (that
sandbox is for code the *model* writes; this one runs code *you* wrote).

## 4. Contract the server enforces

| Rule | Behaviour |
| --- | --- |
| Root confinement | Only files under `root`, resolved with `PathPolicy` (realpath, symlink-proof, no `..`, no NUL). A file outside is refused with the reason; the rest still load. |
| File set | `*.js` / `*.mjs`, non-recursive by default, sorted, hidden files skipped, ≤ 32 files, ≤ 64 kB each. |
| Shape | Default export must be an array of `{name, description, callback}`. `inputSchema` optional (default: permissive object). A bad entry is reported and skipped — never a half-loaded file. |
| Names | `^[a-z][a-z0-9_-]{1,40}$`, unique across all files; collisions are refused by name. Reserved names (`tool_files`, `reload_tools`) refused. |
| Call | `await callback(args, context)` where `context = { log, file, tool, signal }`. Sync and async both fine. Undefined → `null`. |
| Result | JSON-serialised with a depth cap and `max_result_bytes` (§ cap → `"truncated": true` note). Functions, symbols, cycles are stripped, never thrown on. |
| Failure | A thrown error, a rejected promise, or a timeout comes back as `Error: <message>` with `isError: true` — which the chat already renders as `toolbox__greet → failed: …` and refuses to let a stated value stand next to. |
| Reload | `reload_tools` re-imports changed files (`import(url + '?v=' + mtime)` cache-busting) and answers with the diff; `tool_files` lists file, tools, mtime, sha256; `tools/list` re-checks mtimes on every call. |
| Timeout | `timeout_ms` (default 5000) caps a *pending* call. A synchronous busy loop cannot be interrupted in-process — documented, and the reason `isolation: "worker"` exists as a phase-3 option. |

Console-side refresh: the client (`src/mcp/client.ts`) currently ignores
`notifications/tools/list_changed` and the kit advertises `listChanged: false`. Phase 2 makes
the kit announce it and the client re-request `tools/list`, so a reload reaches the chat
**without a console restart**; until then `mcp stop toolbox && mcp start toolbox` (or the MCP
panel) is the honest way to pick up a new file.

## 5. Tests (`tests/toolbox-mcp.test.ts`, ~14 cases)

1. two tools in one file → `tools/list` returns both, with the declared schema.
2. sync callback → result text is the JSON value.
3. async callback → awaited, not a promise.
4. `undefined` return → `null`.
5. callback throws → `isError: true`, message preserved.
6. bad file (default export not an array) → refused, reason names the file.
7. entry without `callback` → that entry skipped, its name listed as refused.
8. duplicate name across two files → second refused, first still callable.
9. reserved / illegal name → refused.
10. file outside the root (`../secrets.js`) → refused by `PathPolicy`.
11. oversized result → truncated, with the flag.
12. `reload_tools` after the file changes on disk → the new tool appears, the removed one goes.
13. `tool_files` → file, names, mtime, sha256.
14. integration: `buildSystemPrompt` with the toolbox listing → `toolbox__greet(who)` is
    declared (proves the tools reach the model's context).

## 6. Gate (same as every other task)

```
npx tsc --noEmit && npm run lint && npm run build && npx vitest run
```
Baseline to keep green: **319 passed | 6 skipped (325)**.

## 7. Live acceptance (what "done" looks like, probeable)

1. `node dist/cli.js mcp call toolbox__greet '{"who":"Amine"}'` → `{"greeting":"Hello Amine"}`.
2. `GET /api/mcp` → seven servers ready, `toolbox` with 2 tools.
3. Chat: *"greet Amine using your tools"* → the model calls `toolbox__greet({"who":"Amine"})`
   and the reply repeats the greeting the callback produced (a value the runtime can check
   against the payload — the same fidelity guard as the code sandbox).
4. Add a second file while the console runs, call `toolbox__reload_tools`, ask again → the new
   tool is offered and callable.

## 8. Risks

- **Trust:** a tool file runs with full Node privileges in the server process. Not a sandbox;
  the README says so in those words, and `code.mjs` stays the sandboxed path. No tool file is
  ever written by the model into this folder automatically.
- **Blocking callbacks:** see §4/§2.
- **Prompt cost:** each tool is a declaration in the system prompt. The round-robin budget
  already shares it out and lists what does not fit as `name(args)`; `max_tools` (24) keeps a
  runaway folder from flooding it.
- **Windows:** imports use `pathToFileURL` (never a bare path), discovery uses
  `node:fs` + `path` only, no shell. Cross-refs `PLAN-windows-linux-parity.md` §2f.

## 9. Phases

| Phase | Contents | Size |
| --- | --- | --- |
| P1 | server + loader + limits + example file + `mcp.json` + README + tests; restart-to-reload | ~450 LOC + tests |
| P2 | `reload_tools` diff, mtime watch, `tools/list_changed` end-to-end, `.cache.json` | ~150 LOC |
| P3 | optional `isolation: "worker"` with a hard timeout | ~120 LOC |

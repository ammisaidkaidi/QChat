# InfAgent

Agent infrastructure toolkit — strict TypeScript, ESM-only, library **and** CLI,
plus a **Vue interface** with two tabs: a chat agent running **Qwen3-0.6B locally**
(CPU, llama.cpp) and a console for the agent's script toolbox.

- Node **≥ 20.11**, ESM (`"type": "module"`), TypeScript strict
- Library + CLI + HTTP API + Vue 3 / Tailwind / daisyUI console
- Local chat model: Qwen3-0.6B GGUF (Q4_K_M, ~380 MB) via `node-llama-cpp`, no API key, fully offline
- The chat model calls the script toolbox as tools (`<tool_call>` protocol)
- Agent scripts as self-describing files: `.js` / `.py` with a prompt header
- Built-in callbacks: `createScript`, `removeScript`, `listScripts`, `readScript`, `updateScript`, `searchScripts`, `runScript`, `describeScript`, `scriptStats`
- Env as a first-class citizen: `env.txt` → `.env`, secrets redacted

---

## Quick start

```bash
# 1. install everything (the root install pulls in ui/ as well)
npm install

# 2. build and run the console (API + interface on one port)
npm run ui:build         # interface → ui/dist
npm run build            # TypeScript → dist/
npm run serve            # → http://localhost:8787

# 3. chat tab: download the model once (~380 MB), then talk to it
npm run chat:model       # or click "Download model" in the Chat tab
npm run chat:ask -- "Use a tool to greet Amina"
```

Tip for Windows: put trailing explanations **above** a command, never after it on
the same line — `cmd.exe` has no `#` comment and would pass the words to the
program (this bites in `package.json` scripts too, see the troubleshooting notes
below).

# 3. or drive the scripts from the terminal
npx tsx src/cli.ts scripts list
npx tsx src/cli.ts scripts run hello '{"name":"world"}'
```

## Chat tab — local models on CPU

The model runs in-process through llama.cpp; nothing leaves the machine.
Fourteen models ship in the catalogue and the picker in the Chat tab switches
between them; the weights are downloaded on demand.

| Model | Weights | Style |
| --- | --- | --- |
| `Qwen3-0.6B-Q4_K_M` **default** | 0.4 GB | Qwen3 tools (`<tool_call>`) |
| `Qwen3-4B-Thinking-2507-Q4_K_M` | 2.5 GB | Qwen3 tools, reasoning block before the answer |
| `Hammer2.1-3b-Q4_K_M` | 1.9 GB | function-calling fine-tune, JSON array of calls |
| `xLAM-2-3B-fc-r-Q4_K_M` | 1.9 GB | function-calling fine-tune, JSON array of calls |
| `xLAM-1b-fc-r-Q4_K_M` | 0.9 GB | the 1B member of the same family |
| `Nexus-TinyFunction-1.2B-Q4_K_M` | 0.7 GB | LFM2.5 fine-tune, ChatML + `<tool_call>` |
| `Yantra-1B-Agent-Q4_K_M` | 0.7 GB | MiniCPM5-based tool-calling agent |
| `FunctionGemma-270M-Q4_K_M` | 0.3 GB | Google function calling (own call syntax) |
| `MiniCPM5-1B-Q4_K_M`, `Gemma-3-1B-IT-Q4_K_M`, `Llama-3.2-1B-Instruct-Q4_K_M` | 0.7-0.8 GB | 1B instruct models, ChatML prompts |
| `Qwen2.5-0.5B-Instruct-Q4_K_M`, `LFM2.5-350M-Q4_K_M`, `SmolLM2-360M-Instruct-Q4_K_M` | 0.2-0.5 GB | small/fast chat models |

Fourteen in total — the full table, per-model licences and the styles that decide
how each one is prompted live in [models/README.md](models/README.md).

| | |
| --- | --- |
| Folder | `models/` next to the project — see [models/README.md](models/README.md) |
| Backend | CPU only, 2 threads by default, per-model context (4096 tokens for every catalogued model) |
| Speed | ~10-17 tok/s on 2 cores for the 0.6B; first token ≈ 1.3 s warm, ~4 s cold |
| Memory | ~1 GB RSS for the 0.6B; ~3 GB for the 3B models, ~4 GB for the 4B |
| Unload | automatic after 10 idle minutes |

How it works:

1. The system prompt declares every script in the Scripts tab, the agent
   callbacks and each connected MCP tool, in the shape the active model was
   trained on — Qwen3's `<tools>` block for `qwen3` and `plain` models, or
   `[BEGIN OF AVAILABLE_TOOLS]` for the Hammer2.1 / xLAM ones. Declarations are trimmed and budgeted to the model's
   context, so a wall of MCP tools cannot crowd out the conversation.
2. The model replies with `<tool_call>{"name": "hello", "args": {…}}</tool_call>`,
   or with a JSON array of calls on the models that answer that way.
3. The server executes the call against the same registry as the Scripts tab,
   feeds the result back, and streams the final answer.
4. Token streaming, the reasoning block and tool activity are all shown live.

Practical notes:

- **Thinking mode follows the model.** Off for the default 0.6B (which still
  emits a reasoning block on tool turns) and on for Qwen3-4B-Thinking; either way
  the reasoning is streamed into a collapsible "reasoning" section.
- **Tool calling is defended in depth.** Qwen3-0.6B does not always follow its
  own protocol, so the engine declares tools in the exact trained shape, retries
  once when a reply arrives with no call at all, salvages calls with missing
  tags or mangled names (`list_scripts` → `listScripts`), and finally answers
  from the registry itself if the model still refuses. When a reply ignores the
  tool result ("I have several scripts available."), the factual line is
  appended, so the user always sees what the tool found.
- Tool turns take 10-20 s on 2 cores including the reasoning block; plain chat
  replies land in 1-2 s.
- If the model returns nothing usable (a 0.6B model occasionally echoes JSON or
  goes blank), the server appends a factual one-line summary of the tool result,
  so the outcome is never lost.
- `INFAGENT_ALLOW_RUN=0` disables tool execution and the model is told it has no tools.

```bash
infagent chat status              # active model, folder, context, RAM
infagent chat models              # every model in the folder
infagent chat use Hammer2.1-3b-Q4_K_M  # switch the active model
infagent chat download [model-id]    # fetch the GGUF into the weights folder
infagent chat ask "…" [--thinking] [--no-tools] [--temp 0.4] [--max 512]
infagent chat unload              # free ~1 GB of RAM now
```

### Tool protocol — one JSON object per reply

A reply is never free text with a call hidden inside it. The model emits exactly
one JSON object and that object says what it is:

```json
{"type":"tool_call","plan":"List the scripts first","calls":[{"name":"listScripts","arguments":{}}]}
{"type":"final","content":"You have three scripts: hello, disk, ping."}
```

A step may carry up to four calls in `calls`, and `plan` (optional, at most 240
characters) is the model's own one-liner for what the step is for. The console
and the CLI show it as a 📋 line above the calls.

The third shape is produced by the runtime, never by the model — after running
the calls the engine injects it as a user turn:

```json
{"type":"tool_result","calls":[{"name":"listScripts","ok":true,"result":[…]}]}
```

So "the model asked for a tool" and "a tool answered" are told apart by one
field, not by pattern-matching prose, and a model cannot invent tool output.

The format is held by three layers:

1. **Grammar** — `llama.createGrammarForJsonSchema()` (node-llama-cpp, already a
   dependency) constrains the whole completion, with `name` limited to the tools
   actually offered this turn. Malformed JSON is not unlikely, it is
   unrepresentable. Turn it off with `INFAGENT_TOOL_GRAMMAR=0`.
2. **Prompt** — the envelope contract and both examples are stated in the system
   prompt (`ENVELOPE_SPEC`), and tool results arrive as the `tool_result` object
   with the instruction to answer with `final`.
3. **Parse, then repair** — `parseEnvelope()` rejects prose, fences, unknown
   types, calls to tools that were not offered and any model-written
   `tool_result`, each with a reason. The engine spends at most two correction
   turns on a reply that failed, then falls back to the lenient parser so a
   stubborn model still works. The number of repairs appears next to the
   token/latency line of that reply.

Per model: `toolProtocol` in `models/<id>.settings.json` — `strict-json`
(default) or `native`, which keeps a fine-tuned model's own call shape
(`Hammer2.1`, `xLAM`) in the prompt while results still arrive as the envelope.
Globally: `INFAGENT_TOOL_PROTOCOL=legacy` restores the pre-protocol wording for
every model, and `INFAGENT_TOOL_PROTOCOL=native`/`strict-json` force one mode.

The runtime, not the model, is the authority on what a tool returned. When a
reply denies a non-empty result ("there are no scripts"), states a count the
payload contradicts, lists only some of a small catalogue as if it were all of
it, or hides a failure, the facts replace it; when it simply ignores the payload,
they are appended under it. An empty list, an error and a missing result are
three different things and are never rendered as one.

Measure it instead of guessing: `node tools/eval-protocol.mjs` runs 12 read-only
prompts and reports first-try validity, repairs, failed calls, stray calls and
latency per pass (grammar on, grammar off, legacy).

#### Many steps in one task

One reply may take several tool steps: it calls, reads the results, calls again,
and answers when the work is done. "List the files in these three folders and
count them" is three `list_files` calls and then an answer — a reply that tried
to do it in one call would have to invent the folders it never listed.

- **Budget** — 6 steps by default, 1–12. `steps` in the chat header, `--steps N`
  for `infagent chat ask`, or `INFAGENT_MAX_STEPS` for everything. Each step may
  still carry up to four calls, so a reply can do a lot without a second
  message. Steps used, like repairs, are a budget the model spends, not a limit
  on the task: a request needing more is a follow-up message away.
- **A plan it follows** — the system prompt asks for the plan of the task and
  for one line per step; each result comes back with a running list of the calls
  made so far and their numbers (`step 1 · list_files({"/tmp/a"}) → count: 3`),
  so a later step merges earlier results instead of re-running them.
- **The sum is computed here** — when the same tool was used more than once with
  different arguments and every payload carries the same number (a folder
  listing's `count`/`totals.files`), the runtime adds them up. An answer that
  states a different total is replaced by the facts, one that leaves the total
  out gets `Total across the 3 results: 13 files.` appended, and no total is
  offered when a step failed or a listing was cut short — an undercount
  presented as a total is exactly the kind of guess this project refuses.
- **The last step is the answer's** — if the budget runs out while the model
  still wants another call, one more turn is taken with a grammar that can only
  produce `final`, so the user gets the answer to what was already done instead
  of a dangling call.

### Models folder

```
models/
  models-settings.json                       # which model is active, and the order
  Qwen3-0.6B-Q4_K_M.settings.json            # how to run each model (committed)
  Hammer2.1-3b-Q4_K_M.settings.json
  xLAM-2-3B-fc-r-Q4_K_M.settings.json
  Qwen3-4B-Thinking-2507-Q4_K_M.settings.json
~/.cache/infagent/models/*.gguf              # the weights (never in git)
```

Each model is a GGUF plus a settings file carrying its context size, threads,
sampling defaults, chat wrapper and download source. Drop a new `.gguf` in and
the next scan writes a settings file for it; `GET /api/models` and
`PUT /api/models/active` drive the picker in the Chat tab.

CLI equivalents: `npm run chat:model`, `npm run chat:ask -- "…"`.

### Thinking styles — `models/systemPrompts.json`

The **🧠 Prompts** tab holds the *way of thinking* the agent should use. Each
template is one entry in a plain JSON array:

```json
[
  {
    "name": "Step by step",
    "description": "Show the reasoning as numbered steps.",
    "prompt": "Work through the request in numbered steps: …",
    "tags": ["reasoning"],
    "builtin": true
  }
]
```

- Six templates ship with the project (Precise, Step by step, Tool first,
  Explain simply, Skeptical, Options); edit, duplicate, delete or add your own.
- The picker in the **Chat** tab (🧠 next to the model selector) chooses the
  active one; “default style” answers with no style guide at all.
- The chosen `prompt` is injected into every system prompt as a short
  **`# Working style`** section, right after the identity — high enough that a
  small model does not lose it under the tool declarations.
- The selection is remembered in `models/models-settings.json` (`activePrompt`),
  so the JSON file stays a clean array as above.
- Per turn, `POST /api/chat/completions` accepts `promptTemplate` to override the
  selection (`""` = no style guide), which the CLI and tests use.

API: `GET /api/prompts`, `POST /api/prompts` (create/update), `DELETE
/api/prompts/<name>`, `PUT /api/prompts/active` with `{ "name": "…" }`.

Interface development with hot reload (`vite` on 5173, proxying `/api` to 8787):

```bash
npm run serve           # terminal 1 — API
npm run ui:dev          # terminal 2 — interface
```

## The `scripts/` folder

This folder belongs to the agent. It contains **only** `.js` and `.py` files
(plus a one-line `package.json` ESM marker the registry writes so the `.js`
files run as ES modules anywhere they are copied).

Every script starts with a header that is both a docstring and an agent prompt:

```js
/**
 * @infagent-script v1
 * @name hello
 * @language js
 * @description Greet a person by name…
 * @callback run({ name }) -> { ok, result }
 * @usage node scripts/hello.js '{"name":"World"}'
 * @params [{"name":"name","type":"string","required":false}]
 * @agent
 *   Use this script when the user greets someone.
 *   Call it with {"name": "<person>"} and read result.greeting.
 */
```

**Invocation contract** — one JSON argument in, one JSON envelope out:

```
node scripts/hello.js '{"name":"InfAgent"}'      →  {"ok":true,"result":{…}}
python3 scripts/disk_report.py '{"min_free_gb":5}'  →  {"ok":true,"result":{…}}
```

Failures print `{"ok":false,"error":"…"}` and exit non-zero — an agent must read
the envelope instead of assuming the call succeeded.

## Built-in callbacks

| Callback | Purpose |
| --- | --- |
| `listScripts()` | every script, with description and language |
| `searchScripts(query)` | match name, description or agent prompt |
| `readScript(name)` | metadata + full source |
| `describeScript(name)` | metadata only |
| `createScript({…})` | scaffold a `.js`/`.py` file with a generated header |
| `updateScript(name, patch)` | patch header fields and/or body |
| `removeScript(name)` | delete a script |
| `runScript(name, args)` | execute, capture stdout/stderr + envelope |
| `scriptStats()` | counters by language, total size, managed folder |

```ts
import { createScript, runScript, scriptSystemPrompt } from 'infagent';

createScript({
  name: 'disk_report',
  language: 'py',
  description: 'Report free disk space per volume.',
  params: [{ name: 'min_free_gb', type: 'number' }],
});

const result = await runScript('disk_report', { min_free_gb: 5 });
console.log(result.envelope);

// Hand this to an LLM as its system prompt / tool descriptions:
const tools = scriptSystemPrompt();
```

### Screenshots — `relativePath`

`screen_shot` reports the file it wrote twice: `file` is always the absolute
path, `relativePath` is the path relative to the repository root when the image
is inside it, and the absolute path again when it is not (a `../../tmp/...`
label tells nobody anything). Both are plain strings; pass whichever suits the
message you are building.

## Internet, MCP servers and skills

The agent is not limited to the scripts folder. Three capabilities extend what
it can do, and all three are visible in the interface, the REST API and the CLI.

**Internet search and page fetching** — `webSearch` and `webFetch` are declared
to the model as tools, so it can look things up on its own:

```bash
infagent search "node.js lts release" --limit 5
infagent fetch https://example.com --max 2000
infagent alert "Build finished" --level success
```

No key is needed: DuckDuckGo's HTML endpoint answers first and Bing's RSS
endpoint takes over when a network (datacenters, some VPNs) gets the DuckDuckGo
"select all squares containing a duck" challenge. Set `BRAVE_API_KEY` or
`TAVILY_API_KEY` and those providers are used instead, because they return
cleaner data. `INFAGENT_SEARCH_PROVIDER=bing|brave|tavily|duckduckgo` forces an
order, `INFAGENT_ALLOW_NET=0` switches the whole capability off, and the Chat
tab has an *Internet access* switch per conversation.

**MCP servers** — `mcp.json` declares servers in the standard
[JSON-RPC 2.0](https://spec.modelcontextprotocol.io) protocol, over one of two
transports: a `command`/`args`/`env` entry is spawned as a child process and
spoken to on stdin/stdout, while `"transport": "http"` speaks Streamable HTTP to
a remote `url` with optional `headers`. `${VAR}` placeholders in `url`, `args`,
`env` and `headers` are expanded from the app's environment (`.env`), so a token
is never written into `mcp.json` itself.

```json
{ "servers": { "example": { "command": "node", "args": ["mcp/example-server.mjs"], "enabled": true } } }
```

Enabled servers start in the background at boot, their tools are offered to the
model as `server__tool` (so `example__echo`), and the console's **MCP** tab can
connect, disconnect, add servers and call any tool by hand. A dependency-free
demo server ships in `mcp/example-server.mjs` (`echo`, `add`, `now`) so the loop
can be verified before a real server is wired in.

Six hardened servers ship in `mcp/servers/`, plus the toolbox (`toolbox.mjs`), which serves your own JavaScript. Nothing is vendored from a package
registry: each guarantee below is enforced inside the server process, not by
asking the model to behave.

| Server | Tools | Enforced |
| --- | --- | --- |
| `filesystem.mjs` | `list_allowed_roots`, `list_directory`, `read_file`, `read_multiple_files`, `get_file_info`, `search_files`, plus `write_file` / `create_directory` only with `allow_write` and `remove_path` only with `allow_delete` | Only the declared roots (`./scripts`, `./skills`, `./screenshot` by default) are reachable. Every path is resolved through symlinks and refused if it leaves a root, contains `..` or a NUL byte, or names a credential file (`.env*`, `.git`, `.ssh`, `*.pem`, `id_rsa`, …). Read-only unless the config says otherwise. Caps: 1 MB per read, 500 entries, depth 4; binary files are refused rather than streamed. |
| `fetch.mjs` | `fetch_url`, `fetch_policy` | https only (`allow_http` opts in). Every DNS answer and every redirect hop is checked against loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges, and the validated address is pinned into the connection so DNS cannot be re-pointed between the check and the request. 1 MB, 3 redirects and a 20 s budget are the defaults; only text-ish content types are returned, the result is flagged `untrusted`, and nothing is executed. |
| `sqlite.py` (stdlib only) | `list_databases`, `list_tables`, `describe_table`, `read_query`, plus `write_query` only with `allow_write` | Read-only is a real SQLite setting — `file:…?mode=ro` plus `PRAGMA query_only=ON` — not just hidden tools. Foreign keys stay on, one statement per call, `ATTACH`/`DETACH`/`VACUUM`/`REINDEX`/`ANALYZE` and any `PRAGMA … =` are refused, and rows, bytes and time are capped. |
| `code.mjs` | `run_javascript`, `run_python`, `code_policy` | Runs a snippet in a fresh temp directory with an empty environment (no tokens, no `HOME`, no `PYTHONPATH`) and a hard time limit (5 s default, 15 s ceiling), deletes the directory afterwards and caps each stream's output. JavaScript goes through `node --experimental-permission`: reading or writing outside the sandbox, `child_process`, workers and native addons are refused by Node. Python goes through `python3 -I -B` with `mcp/lib/pyguard.py`, an audit hook that refuses reads outside the sandbox and the interpreter library, writes outside the sandbox, `os.system`/`exec`/`fork` and `subprocess`, plus sockets — with `ctypes`, `socket`, `subprocess`, `urllib` … un-importable. On Linux each run is wrapped in `unshare -n --map-current-user`, so it has no network interface at all; `code_policy` reports whether that holds here and says plainly that the Python guard is an in-process guard rail, not a kernel boundary. |
| `toolbox.mjs` | every tool a file under `mcp/tools/` exports, plus `tool_files` and `reload_tools` | Your tool files, and nothing else: the root is resolved through symlinks (a symlink is never followed and is reported), files are `*.js`/`*.mjs`, ≤ 32 files, ≤ 64 kB each, ≤ 24 tools. A tool needs a valid lower-case name (`lower_case`, 2–41 chars), a description and a `callback` function; a bad entry is refused by name instead of taking the file down. Calls are capped at `timeout_ms` (5 s) and their JSON at `max_result_bytes` (64 kB), and a result JSON cannot carry (cycles, functions, BigInt) is converted rather than thrown. **A tool file is trusted code and runs with the server's privileges — this is not a sandbox; for model-written code use `code`.** |
| Supabase (official remote endpoint) | whatever the project's tool groups expose | `transport: "http"` to `https://mcp.supabase.com/mcp?project_ref=…&read_only=true`; off by default. The manager refuses a Supabase URL without a bearer token or without `read_only=true` unless `INFAGENT_ALLOW_SUPABASE_WRITES=1`, refuses plain http unless it is loopback *and* `INFAGENT_MCP_ALLOW_INSECURE=1`, and never prints the token — errors are redacted. |

```bash
infagent mcp list
infagent mcp start filesystem
infagent mcp call filesystem__read_file '{"path":"scripts/hello.js"}'
infagent mcp call sqlite__read_query '{"database":"demo","sql":"select * from notes limit 5"}'
infagent mcp call code__run_python '{"code":"import statistics; print(statistics.mean([3,4,5]))"}'
infagent mcp call code__run_javascript '{"code":"console.log([1,2,3].reduce((a,b)=>a+b,0))"}'
infagent mcp call toolbox__greet '{"who":"Amine"}'
infagent mcp call toolbox__reload_tools '{}'
```

**Running code from the chat.** With the `code` server enabled the model can
calculate, reshape data and parse text instead of guessing — the tool result it
reads is the real output of a real process. Ask for it directly ("run a Python
snippet that …"), or let the model reach for `code__run_python` on its own. The
same policy applies to both languages, and `code__code_policy` prints it:

- **What it can touch** — one throwaway directory per run, which is also its
  working directory. Relative paths resolve inside it; absolute paths outside it
  are refused (JavaScript by Node's permission model, Python by the audit hook).
- **What it cannot** — start a process, open a socket, read your `.env`, reach a
  file outside the sandbox. Nothing of InfAgent's environment is passed down.
- **Limits** — `timeout_ms` (default 5000, max 15000), `max_output_bytes`
  (default 64 KiB, ceiling 256 KiB), `code` at most 20000 characters. A run that
  hits the time limit is killed as a process group and reported as
  `timed_out: true`, not as an empty result.
- The defaults live in `mcp.json`; raise `timeout_ms` there if a snippet needs
  longer. Set `allow_network: true` to give runs the network back — off by
  default, and on Linux off means "no interface", not "asked nicely".

**Your own tools, in JavaScript.** Put a file in `mcp/tools/` and the chat can
call what it exports — the model sees the tool exactly like the built-in ones,
with its name and arguments, and a call returns the callback's own value:

```js
// mcp/tools/hello.js
export default [
  {
    name: 'greet',
    description: 'Greet someone by name.',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    callback: ({ who }) => ({ greeting: `Hello ${who}!` }),
  },
];
```

- `callback` may be `async`; it gets the call's arguments and `{ file, tool, log }`.
- Edit or add a file, then call `toolbox__reload_tools` — or send `force: true` — and the
  new tools are in the model's context from the next message on. `toolbox__tool_files`
  reports what is loaded (file, mtime, sha256, tools) and what was refused, and the server
  announces `tools/list_changed`, so the console updates the list without a restart.
- `mcp/tools/README.md` holds the two-line contract and the limits; the trust model is the
  one place this differs from the `code` server: **a tool file is code you installed and it
  runs unsandboxed** — it is not a place for code the model wrote.

**Supabase, connected.** The official remote endpoint is the entry in `mcp.json`;
it needs two values in `.env` (never in the config file) and a project reference:

```bash
# .env — gitignored; `npm run env:from-txt` regenerates it from env.txt
SUPABASE_ACCESS_TOKEN=sbp_…      # Supabase dashboard → Account → Access tokens
SUPABASE_PROJECT_REF=abcdefghijklmnop   # the ref in your project URL
```

Then `infagent mcp start supabase` (or the **Connect** button in the MCP tab).
It connects **read-only**: the URL pins `read_only=true`, and the server refuses
the connection if the flag is missing unless `INFAGENT_ALLOW_SUPABASE_WRITES=1`
is set deliberately. With that flag off, a write is rejected by Postgres itself
(`ERROR 25006: cannot execute INSERT in a read-only transaction`), not merely by
hiding a tool. Verified end to end against a real project: `list_tables`,
`execute_sql` (read) and `list_migrations` all answer, `create table` and
`insert` are refused.

If the connection fails, the error says which of the two it is: an **auth**
problem (401/403 → check the token) or an **edge block** — hosted endpoints sit
behind Cloudflare, which answers an unrecognised client with "Error 1010:
browser_signature_banned". Every remote request carries a real `User-Agent` for
that reason, and an edge refusal is reported as such rather than as a bad token.
A server that is simply switched off in `mcp.json` is labelled **disabled** with
a Connect button, not shown as an error.

Adding a third-party server by hand works the same way (the Add server form
accepts anything from `npx -y @modelcontextprotocol/server-filesystem .` to a
remote URL), but its guarantees are then that package's, not InfAgent's.

**Choosing which servers a chat may use.** The 🔧 button beside the message box
lists every enabled server with its tool count and state; ticking one off hides
its tools from the model *and* makes a call to it fail, so the selection is a
restriction rather than a suggestion. The button reads `all 7`, `4/7` or
`all off` at a glance, and **Save** in the settings panel keeps the choice for
the next visit (until then it applies to the next message only). Every enabled
server stays the default, so a server connected later is offered without
returning to the picker. Per turn the selection travels as
`POST /api/chat/completions` → `{ "mcpServers": ["toolbox"] }` (`[]` = none,
omitted = all); the CLI has `--mcp a,b` and `--no-mcp`.

**Skills** — reusable procedures kept as markdown files in `skills/`. Only the
one-line summary (`name`, `description`, `when to use it`) goes into the system
prompt; the steps are read on demand through `readSkill`, so a long playbook
costs nothing until it is used. The model can also save a new one with
`createSkill`, and the **Skills** tab edits them with a live markdown preview.

```bash
infagent skills list
infagent skills read web-research
infagent skills create deploy-check --desc "Pre-deploy sanity checks" --when "Before a release"
```

**Alerts** — the one callback whose output is for the human rather than the
model. Ask for one in plain language ("show me an alert when the export
finishes") and the model calls `showAlert`, which pops a toast in the console
with a title, a message and a level (`info`, `success`, `warning`, `error`):

```bash
infagent alert "Backup finished" --title "Nightly" --level success
curl -X POST localhost:8787/api/alerts -d '{"message":"Deploy done","level":"success"}'
```

The CLI posts to the running console so the toast appears there (and prints a
terminal banner when no console is up), scripts can do the same over HTTP, and a
script that raises an alert while the console is closed still shows it once on
the next visit. Alerts are also mirrored to the desktop notification area when
the browser allows it and the tab is in the background.

Two starter skills are included: `web-research` (search, read two sources,
answer in three sentences with URLs) and `disk-hygiene` (use the `disk_report`
script, then propose what to clean). The file format is documented in
[skills/README.md](skills/README.md).

## CLI

```bash
infagent serve [--port 8787]          # API + interface
infagent scripts list [--json]
infagent scripts search <query>
infagent scripts read <name>
infagent scripts prompt <name>        # how an agent should call it
infagent scripts create <name> --lang js --desc "…" [--force]
infagent scripts update <name> --desc "…" --prompt "…" --body file.js
infagent scripts remove <name>
infagent scripts run <name> '{"json":"args"}'
infagent scripts stats
infagent tools [--json]               # JSON-schema tool defs for an LLM
infagent config | run <task> | --version
```

## HTTP API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | version, node, folder, counters |
| `GET /api/scripts` | list + stats + system prompt |
| `POST /api/scripts` | create |
| `GET /api/scripts/:name` | detail + source |
| `PATCH /api/scripts/:name` | update |
| `DELETE /api/scripts/:name` | remove |
| `POST /api/scripts/:name/run` | `{ "args": {…} }` → run result |
| `GET /api/scripts/:name/prompt` | ready-to-paste agent prompt |
| `GET /api/tools` | tool schemas + system prompt |
| `GET /api/chat/status` | engine state, model path, context, RAM, defaults |
| `POST /api/chat/model/download` | SSE progress while fetching the GGUF |
| `DELETE /api/chat/model` | unload the model from memory |
| `POST /api/chat/completions` | SSE token stream (`status`, `thinking`, `token`, `tool_call`, `tool_result`, `reset`, `plan`, `stats`, `done`); per-turn `net`, `tools`, `promptTemplate`, `maxToolIterations`, `mcpServers` |
| `GET /api/alerts?limit=…` | recent alerts, newest first |
| `POST /api/alerts` | raise one (`{ message, title?, level? }`) → 201 |
| `DELETE /api/alerts` | clear the stored alerts |
| `GET /api/alerts/stream` | SSE feed: every alert as it is raised |
| `GET /api/search?q=…&limit=…` | web search → `{ provider, query, results[] }` |
| `POST /api/web/fetch` | `{ "url": "…", "maxChars": 4000 }` → `{ title, text, truncated }` |
| `GET /api/skills` | list skills with their file metadata |
| `POST /api/skills` | create a skill |
| `GET /api/skills/:name` | one skill (front matter + body) |
| `PUT /api/skills/:name` | update a skill |
| `DELETE /api/skills/:name` | remove a skill |
| `GET/PUT /api/env` | read the `.env` (secrets masked) / write or remove keys |
| `POST /api/env/reveal` | one secret (`{"key":"…"}`) or every secret (`{"all":true}`) in plain text, on an explicit click |
| `GET/POST /api/prompts`, `PUT /api/prompts/active`, `DELETE /api/prompts/<name>` | thinking-style templates and the selection |
| `GET /api/mcp` | `{ configPath, servers[], tools[] }` |
| `POST /api/mcp/servers` | add a server to `mcp.json` |
| `DELETE /api/mcp/servers/:name` | remove a server |
| `POST /api/mcp/servers/:name/start` \| `/stop` | connect or disconnect it |
| `POST /api/mcp/tools` | `{ "tool": "server__tool", "args": {…} }` → call result |
| `GET /api/toolbox` | the tool files: `{ root, files[], refused[], tools[], server, limits }` |
| `GET /api/toolbox/file?name=…` | one tool file's source → `{ name, content, bytes, mtime }` |
| `PUT /api/toolbox/file` | `{ "name": "my-tools.js", "content": "…" }` → `{ file, reload }` |
| `DELETE /api/toolbox/file?name=…` | remove a tool file → `{ file, reload }` |
| `POST /api/toolbox/reload` | re-import the folder → `{ reload: { ok, added[], removed[], refused[] } }` |
| `GET /api/models` | the `models/` catalogue (ids, sizes, active flag) |
| `PUT /api/models/active` | switch the active model |
| `POST /api/models/refresh` | adopt GGUFs dropped into the folder |

## Interface (Vue 3 + Tailwind + daisyUI)

`ui/` is a small console that follows the same design language as the API:

Seven tabs in the header: **Chat**, **Scripts**, **Skills**, **Toolbox**, **MCP**,
**Prompts** and **Config**.

- **Chat** — local Qwen3-0.6B conversation: model picker over the `models/`
  folder, download button with progress, streaming bubbles, collapsible
  reasoning, tool-call cards with arguments and results, **copy** and retry on
  every reply, settings (temperature, max tokens, thinking, tools, custom system
  prompt), an *Internet access* switch for `webSearch` / `webFetch`, a 🔧
  **MCP-server picker** beside the message box, a *Send a test alert* button,
  Stop / Clear, history kept in `localStorage`
- **Alerts** — toasts for anything raised by `showAlert`, the CLI or the API,
  with a bell counter in the header and *Dismiss* / *Dismiss all*
- **Scripts** — searchable script list, detail tabs (overview, *Agent prompt*
  copyable, source, run console with the parsed envelope) and the tool console
  that invokes the built-in callbacks as an LLM would
- **Skills** — clickable list, rendered markdown body, *New* / *Edit* / *Copy* /
  *Delete*, and the same files the model reads through `readSkill`
- **MCP** — a card per server with a live state badge (`ready`, `starting`,
  `error`), connect / disconnect / remove, an add-server form and a *Try a tool*
  console that calls `server__tool` through the same dispatcher the model uses
- **Toolbox** — `mcp/tools/` itself: every tool file with the tools it exports
  and whether it loaded, the file open in an editor (**Save & reload** writes it
  and re-imports, so the next message can already call the new tool), **+ New
  file** from a template, **Upload** (button or drag a `.js`/`.mjs` file onto
  the list), **Delete** behind a confirmation, and **↻ Reload server** for a
  file changed outside the console. A save answers with the server's own report
  — `+roll` / `−roll` / *no change* — and refusals are shown with their reason;
  the same folder's rules apply as in the MCP server: ≤ 32 files, ≤ 64 kB each.
  Creating, uploading or editing a file means running code you installed — the
  tab says so once, and the server stays the only thing that decides what loads.

## Environment: `env.txt` is the source of truth

```
env.txt ──(npm run env:from-txt)──▶ .env          ← gitignored, read by the app
                                ──▶ .env.example   ← committed, secrets blanked
```

Keys matching `SECRET|TOKEN|PASSWORD|PASS|…|DATABASE_URL` are written to `.env`
but blanked in `.env.example`. The previous `.env` is backed up to `.env.bak`.

### Config tab — editing `.env` from the console

The **⚙️ Config** tab lists every key with its section, the comment from
`.env.example` and a value field. Rules it follows:

- **Add a variable with the button.** `＋ Add variable` opens a name/value row;
  the new keys are listed under *new variables (not saved yet)*, are validated
  as you type (`[A-Za-z_][A-Za-z0-9_]*`) and are written on Save under a
  `# ---- added from the console ----` banner. Typing a name that already exists
  edits that key instead of creating a second line.
- **No secret is in the payload unasked.** Keys that look like credentials are
  reported as `set` plus a mask (`••••••`); `GET /api/env` returns no secret
  value, so a snapshot, a log or a screenshot cannot leak one.
- **Reveal is an explicit click.** The 👁 next to a key asks the server for that
  single value (`POST /api/env/reveal` with `{ "key": "SMTP_PASS" }`), and
  **Reveal secrets** asks for all of them at once (`{ "all": true }`); **Hide
  secrets** puts the masks back. A revealed value is plain text on screen for as
  long as you leave it open — the server echoes it, never logs it, and answers
  with `cache-control: no-store`.
- **Untouched stays untouched.** Only the fields you edit are sent, so saving
  never rewrites a credential you did not touch.
- **A write is atomic and reversible.** Keys are validated (`[A-Za-z_][A-Za-z0-9_]*`),
  the file is written through a temporary file, previous contents are kept as
  `.env.bak`, and the file stays `0600`.
- **The live process is updated** (`process.env`), so the next chat turn sees the
  new values. MCP servers started earlier keep theirs until restarted from the
  MCP tab.

`env.txt` remains the master reference for a *fresh* `.env`: regenerate with
`npm run env:from-txt`. Edits made in the Config tab change `.env` only — copy
them back into `env.txt` if you want them to survive a regeneration.

Relevant InfAgent variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `INFAGENT_SCRIPTS_DIR` | `./scripts` | managed script folder |
| `INFAGENT_SCRIPT_TIMEOUT_MS` | `30000` | per-run timeout |
| `INFAGENT_ALLOW_RUN` | `1` | set to `0` to disable script execution |
| `INFAGENT_PYTHON` | auto | interpreter for `.py` scripts; without it `python3`, `python` and `py` are probed in that order, so Windows works too |
| `INFAGENT_NAME` | `InfAgent` | agent display name |
| `INFAGENT_MODELS_DIR` | `<project>/models` | models folder |
| `INFAGENT_MODEL_PATH` | `<modelsDir>/Qwen3-0.6B-Q4_K_M.gguf` | explicit model file |
| `INFAGENT_LLM_CONTEXT` | `4096` | context window |
| `INFAGENT_LLM_THREADS` | `2` | llama.cpp threads |
| `INFAGENT_LLM_IDLE_UNLOAD_MS` | `600000` | idle time before the model is freed |
| `INFAGENT_MCP_CONFIG` | `./mcp.json` | MCP server declarations |
| `INFAGENT_MCP_ALLOW_INSECURE` | unset | allow `http://` for loopback remotes only |
| `INFAGENT_ALLOW_SUPABASE_WRITES` | unset | allow a Supabase MCP connection that is not `read_only=true` |
| `SUPABASE_ACCESS_TOKEN` | — | Supabase personal access token, read from `.env` and referenced as `${SUPABASE_ACCESS_TOKEN}` in `mcp.json` |
| `SUPABASE_PROJECT_REF` | — | Supabase project exposed through the remote MCP endpoint |

## When something goes wrong

**`vue-tsc` crashes with `Search string not found: "/supportedTSExtensions = .*(?=;)/"`.**
`ui/` is its own npm package, so the root install has to have pulled its
dependencies; npm otherwise falls back to a *globally* installed `vue-tsc`, which
is often an old 1.x that patches the TypeScript compiler by regex and breaks on
newer TypeScript. Run `npm run ui:install` (or plain `npm install` — the root
`postinstall` does it) and build again; `ui`'s own `prebuild` step now checks the
toolchain first and prints that sentence instead of a stack trace.

**The console says "The Vue interface has not been built yet" on Windows, however
often you build.** That was a Windows-only path bug: the server derived `ui/dist`
from a URL pathname, which on Windows is `/D:/dev/app/ui/dist`, and `path.resolve`
then made `D:\D:\dev\app\ui\dist` — a path that never exists. It now goes
through `fileURLToPath`, so the same clone serves the interface on Windows, macOS
and Linux. Update your checkout if you still see it; `tests/platform.test.ts`
guards the resolution and the request path (percent-encoded `..` included).

**`npm run ui:build` fails with `Could not resolve entry module "#/index.html"`,**
or Vite warns that the project root contains `#`. Something in the script is a
shell comment: npm runs scripts through `sh` on Linux and macOS but through
`cmd.exe` on Windows, and `cmd.exe` has no `#` comment, so
`vite build # build the interface` hands `#`, `build`, … to Vite and `#` becomes
the project root. Delete everything from `#` to the end of the line in
`scripts` — in `package.json`, `ui/package.json` and any script you add — and
keep the explanation in the docs instead. `tests/portability.test.ts` fails the
suite if shell-only syntax creeps back into a script.

**`Missing script: "ui:install"`.** Scripts resolve against the `package.json` of
the current folder — `ui:install`, `ui:build` and the rest live in the *root*
one, so run them from the repository root, not from `ui/`.

**A `.py` script fails with `ENOENT`.** No Python on `PATH` under any of the
usual names; set `INFAGENT_PYTHON` to the interpreter, e.g.
`INFAGENT_PYTHON=py` on Windows.

**A model answers slowly, or llama.cpp reports "too long prompt".** The context
window is per model (`models/<id>.settings.json`), and the system prompt carries
every script, callback and MCP tool. Raise `contextSize` for the model, or
disconnect MCP servers you are not using in the **MCP** tab.

**`tests/screen-shot.test.ts` is skipped.** It drives `scripts/screen_shot.js`
through a real browser, so it runs only when Playwright *and* its chromium build
are present: `npm i -D playwright` then `npx playwright install chromium`. Without
the browser the five cases are reported as skipped rather than failed, and the
`screen_shot` callback itself keeps working on any machine that has a display.

**The weights are missing after a checkout.** They live outside the repository
(`~/.cache/infagent/models` on Linux/macOS, `%USERPROFILE%\.cache\infagent\models`
on Windows) — press **Download** in the Chat tab, or
`infagent chat download <model-id>`.

## Scripts (npm)

| Script | What it does |
| --- | --- |
| `npm run serve` | API + interface from `dist/` |
| `npm run serve:dev` | same, with hot reload (`tsx watch`) |
| `npm run ui:install` | install the interface's own dependencies (the root `postinstall` also does it) |
| `npm run ui:build` / `ui:dev` | build / develop the Vue interface |
| `npm run build` | compile `src/` → `dist/` |
| `npm run build:all` | the library/CLI *and* the interface |
| `npm run verify` | lint, type-check, tests and both builds in one go |
| `npm run dev` | CLI from source with `tsx watch` |
| `npm run typecheck` / `test` / `lint` / `format` | quality gates |
| `npm run env:from-txt` | regenerate `.env` + `.env.example` |
| `npm run chat:model` / `chat:ask` | download the model / ask it a question |
| `node tools/ui-smoke.mjs` | browser smoke test of the console (needs Playwright) |

## Project layout

```
InfAgent/
├── src/
│   ├── cli.ts                 # bin: infagent
│   ├── config/env.ts          # env loading, validation, redaction
│   ├── lib/                   # Agent runtime + public library surface
│   ├── chat/                  # Qwen3 engine, prompts, tool dispatch, splitter
│   ├── scripts/               # script toolbox (header, registry, runner)
│   ├── capabilities/          # web search, page fetching, alerts
│   ├── mcp/                   # JSON-RPC clients (stdio + Streamable HTTP) + manager + guards
│   │                          #   + the toolbox file store behind the Toolbox tab
│   ├── skills/                # markdown skill registry
│   └── server/                # HTTP API (scripts + chat SSE) + static UI
├── ui/                        # Vue 3 + Tailwind + daisyUI interface (own package.json)
├── scripts/                   # agent-authored .js / .py callbacks
├── mcp/                       # bundled MCP servers (filesystem, fetch, sqlite, toolbox, code) + lib/ + data/
│   └── tools/                 # your tool files — the toolbox server loads every *.js / *.mjs here
├── skills/                    # markdown skill files (see skills/README.md)
├── tests/                     # vitest: env, agent, scripts, search, skills, mcp, http
└── tools/                     # env generator, GitHub publish helper, UI deps bootstrap
```

## License

MIT — see `LICENSE`.

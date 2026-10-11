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
npm install

# 1. run the console (API + interface on one port)
npm run ui:build        # build the Vue app into ui/dist
npm run build           # compile the TypeScript to dist/
npm run serve           # → http://localhost:8787

# 2. chat tab: download the model once (~380 MB), then talk to it
npm run chat:model      # or click "Download model" in the Chat tab
npm run chat:ask -- "Use a tool to greet Amina"

# 3. or drive the scripts from the terminal
npx tsx src/cli.ts scripts list
npx tsx src/cli.ts scripts run hello '{"name":"world"}'
```

## Chat tab — Qwen3-0.6B on CPU

The model runs in-process through llama.cpp; nothing leaves the machine.

| | |
| --- | --- |
| Model | `Qwen3-0.6B-Q4_K_M.gguf` (~380 MB, `unsloth/Qwen3-0.6B-GGUF`) |
| Folder | `~/.cache/infagent/models` (override with `INFAGENT_MODELS_DIR`) |
| Backend | CPU only, 2 threads by default, 2048-token context |
| Speed | ~10-17 tok/s on 2 cores; first token ≈ 1.3 s warm, ~4 s cold |
| Memory | ~1 GB RSS while loaded; unloads automatically after 10 idle minutes |

How it works:

1. The system prompt declares every script in the Scripts tab as a Qwen3 tool
   (`<tools>[…]</tools>`), plus `listScripts` / `createScript`.
2. The model replies with `<tool_call>{"name": "hello", "args": {…}}</tool_call>`.
3. The server executes the call against the same registry as the Scripts tab,
   feeds the result back, and streams the final answer.
4. Token streaming, the reasoning block and tool activity are all shown live.

Practical notes:

- **Thinking mode is off by default.** Qwen3 still emits a reasoning block on
  tool turns; it is streamed into a collapsible "reasoning" section.
- Tool turns take 10-20 s on 2 cores including the reasoning block; plain chat
  replies land in 1-2 s.
- If the model returns nothing usable (a 0.6B model occasionally echoes JSON or
  goes blank), the server appends a factual one-line summary of the tool result,
  so the outcome is never lost.
- `INFAGENT_ALLOW_RUN=0` disables tool execution and the model is told it has no tools.

```bash
infagent chat status              # engine state, context, RAM
infagent chat download            # fetch the GGUF
infagent chat ask "…" [--thinking] [--no-tools] [--temp 0.4] [--max 512]
infagent chat unload              # free ~1 GB of RAM now
```

CLI equivalents: `npm run chat:model`, `npm run chat:ask -- "…"`.

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
| `POST /api/chat/completions` | SSE token stream (`status`, `thinking`, `token`, `tool_call`, `tool_result`, `stats`, `done`) |

## Interface (Vue 3 + Tailwind + daisyUI)

`ui/` is a small console that follows the same design language as the API:

Two tabs in the header: **Chat** and **Scripts**.

- **Chat** — local Qwen3-0.6B conversation: model status, download button with
  progress, streaming bubbles, collapsible reasoning, tool-call cards with
  arguments and results, settings (temperature, max tokens, thinking, tools,
  custom system prompt), Stop / Retry / Clear, history kept in `localStorage`
- **Scripts** — searchable script list, detail tabs (overview, *Agent prompt*
  copyable, source, run console with the parsed envelope) and the tool console
  that invokes the built-in callbacks as an LLM would

## Environment: `env.txt` is the source of truth

```
env.txt ──(npm run env:from-txt)──▶ .env          ← gitignored, read by the app
                                ──▶ .env.example   ← committed, secrets blanked
```

Keys matching `SECRET|TOKEN|PASSWORD|PASS|…|DATABASE_URL` are written to `.env`
but blanked in `.env.example`. The previous `.env` is backed up to `.env.bak`.

Relevant InfAgent variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `INFAGENT_SCRIPTS_DIR` | `./scripts` | managed script folder |
| `INFAGENT_SCRIPT_TIMEOUT_MS` | `30000` | per-run timeout |
| `INFAGENT_ALLOW_RUN` | `1` | set to `0` to disable script execution |
| `INFAGENT_PYTHON` | `python3` | interpreter for `.py` scripts |
| `INFAGENT_NAME` | `InfAgent` | agent display name |
| `INFAGENT_MODELS_DIR` | `~/.cache/infagent/models` | GGUF cache folder |
| `INFAGENT_MODEL_PATH` | `<modelsDir>/Qwen3-0.6B-Q4_K_M.gguf` | explicit model file |
| `INFAGENT_LLM_CONTEXT` | `2048` | context window |
| `INFAGENT_LLM_THREADS` | `2` | llama.cpp threads |
| `INFAGENT_LLM_IDLE_UNLOAD_MS` | `600000` | idle time before the model is freed |

## Scripts (npm)

| Script | What it does |
| --- | --- |
| `npm run serve` | API + interface from `dist/` |
| `npm run serve:dev` | same, with hot reload (`tsx watch`) |
| `npm run ui:build` / `ui:dev` | build / develop the Vue interface |
| `npm run build` | compile `src/` → `dist/` |
| `npm run dev` | CLI from source with `tsx watch` |
| `npm run typecheck` / `test` / `lint` / `format` | quality gates |
| `npm run env:from-txt` | regenerate `.env` + `.env.example` |
| `npm run chat:model` / `chat:ask` | download the model / ask it a question |

## Project layout

```
InfAgent/
├── src/
│   ├── cli.ts                 # bin: infagent
│   ├── config/env.ts          # env loading, validation, redaction
│   ├── lib/                   # Agent runtime + public library surface
│   ├── chat/                  # Qwen3 engine, prompts, tool dispatch, splitter
│   ├── scripts/               # script toolbox (header, registry, runner)
│   └── server/                # HTTP API (scripts + chat SSE) + static UI
├── ui/                        # Vue 3 + Tailwind + daisyUI interface
├── scripts/                   # agent-authored .js / .py callbacks
├── tests/                     # vitest: env, agent, script toolbox
└── tools/                     # env generator, GitHub publish helper
```

## License

MIT — see `LICENSE`.

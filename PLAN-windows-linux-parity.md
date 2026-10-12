# Plan — one checkout that runs on Windows and on Linux

**Status: proposal. Nothing in the source tree has been changed for this yet.**
Read it, say go (or drop items), and I implement it in the phases below, one
commit each, pushed to `QChat main` (and `InfAgent main`).

---

## 0. First, the message you pasted

```
InfAgent UI → http://0.0.0.0:8787     {"error":"UI bundle not found"}
```

That exact JSON does not exist anywhere in this codebase — the current code
answers **HTML**, not JSON, when the interface is missing
(`src/server/server.ts:162`: *"The Vue interface has not been built yet. Run
`npm run ui:build`…"*). So one of these is true, and it decides what to fix:

1. your clone is older than `main` (the `#` comment in `ui/package.json` that
   broke `npm run ui:build` on Windows was removed in `5d5f1f0`), or
2. you ran the server from a folder whose `ui/dist` is genuinely missing, or
3. the JSON came from another process (a proxy/port-forward layer), not from us.

Three commands tell us which, before anything is changed:

```bat
git -C D:\dev\QChat fetch && git -C D:\dev\QChat status -sb
npm run ui:install && npm run ui:build && dir ui\dist\index.html
node dist\cli.js serve --port 8787 --host 0.0.0.0
```

Phase 1 below adds the startup line that makes this self-explaining.

---

## 1. What is *already* portable (do not redo)

Verified by reading the code, not by assuming:

| Concern | Where | State |
| --- | --- | --- |
| UI folder from `import.meta.url` | `src/server/server.ts:120` `resolveUiDir()` | `fileURLToPath` — the old `.pathname` bug (`D:\D:\…`) is fixed |
| Static path traversal | `server.ts:132` `staticFileFor()` | `relative()` + `isAbsolute()` guard, both platforms |
| CRLF in files written on Windows | `header.ts:50/85/130`, `envFile.ts:130/216`, `skills/registry.ts:82` | normalised to `\n` before parsing |
| Script runner: interpreter + label | `runner.ts:45` `pythonInterpreter()`, `:63` `commandLabel()` | `python3`/`python`/`py` probe, `relative()` instead of `${cwd}/` |
| Python MCP server launch | `mcp.json` → `mcp/servers/python.mjs` | names no interpreter; picks one at start |
| npm scripts | `tests/portability.test.ts` | bans `#`, `$(`, backticks, `;` (the Windows cmd.exe traps) |
| Checkout line endings | `.gitattributes` | `* text=auto eol=lf`, `*.bat`/`*.cmd` CRLF |
| Dates, sizes, JSON, paths in the UI | `ui/src/**` | `Intl`/relative URLs only, no OS assumptions |
| Weights folder | `modelStore.ts:38` | `homedir()` → `C:\Users\<you>\.cache\infagent\models` on Windows, as documented |

---

## 2. What is still not portable — the actual work

### P1 — breaks Windows today

**a. MCP servers that are not `node` cannot start.**
`src/mcp/client.ts:105` spawns `config.command` directly. On Windows the
executable for `npx`, `npm`, `uvx`, `deno`, `pnpm` is a `.cmd`/`.bat` shim, and
Node ≥ 20.12 refuses to spawn those without a shell (`EINVAL`) — so
`"command": "npx"` in `mcp.json` (documented for the Supabase stdio fallback)
silently fails on Windows while working on Linux.
*Fix:* resolve the command on `win32` (`PATHEXT` lookup: `npx` → `npx.cmd`,
`py` → `py.exe`), spawn through `cmd.exe /d /s /c` only when the target is a
shim, and turn `ENOENT`/`EINVAL` into one sentence that names the command and
the platform fix. Pure helper `resolveCommand(command, { platform, env, path })`
so both platforms are unit-tested **on Linux**.

**b. Stopping an MCP server orphans its children on Windows.**
`client.ts:158` sends `SIGTERM`/`SIGKILL`, which on Windows terminates only the
`cmd.exe` shim; the real server (node/python) keeps running and keeps the port
or the database file locked.
*Fix:* on `win32` stop the tree with `taskkill /pid <pid> /T /F` first, then fall
back to `child.kill()`. Same seam: `killArgs(pid, platform)`.

**c. A bundled script cannot even import on Windows.**
`scripts/net_interfaces.py:18` imports `fcntl` at module level — Unix-only, so on
Windows the script dies with `ModuleNotFoundError` before `run()` starts, and the
console reports a broken script.
*Fix:* import it inside the Unix branch; add a portable path
(`socket.getaddrinfo`/`ipconfig` based) so the script answers on Windows with
what the OS does expose, and a `"platforms"` note in the header.

### P2 — breaks part of the workflow on Windows

**d. `npm test` writes to `/tmp`.** `tests/chat.test.ts:197,293,309,407`.
On Windows `/tmp` is `C:\tmp`, which does not exist. *Fix:* `mkdtemp` under
`os.tmpdir()` (the same pattern `tests/mcp-security.test.ts:191` already uses).

**e. `tools/ui-smoke.mjs:21`** defaults `OUT` to `/home/user/preview` — a sandbox
path. *Fix:* `join(ROOT, 'preview')`.

**f. Saving `.env` can fail on Windows.** `src/config/envFile.ts:349` writes a
temp file, `renameSync()`s it over the target and `chmodSync(…, 0o600)`. On
Windows a rename over a file another handle holds (editor, antivirus, a running
console that just read it) raises `EPERM`; `chmod 0600` is a no-op there.
*Fix:* keep the atomic path on POSIX; on `win32` retry the rename once after
`unlinkSync(target)` and skip the mode bits (documented as a POSIX guarantee).

**g. Python sample scripts on Windows.** `system_info.py` and `disk_report.py`
guard every `/proc` read and use `shutil.disk_usage`, so they degrade to partial
output — good. `net_interfaces.py` is the exception (see c). *Fix:* c, plus one
run of all four scripts on Windows in the checklist to prove "partial, not
broken".

### P3 — polish and diagnosability

**h. `serve` should say what it resolved.** Print the UI folder, the settings
folder and the weights folder at startup, and say `(missing — run npm run
ui:build)` when `ui/dist/index.html` is absent. This is the line that would have
answered your paste in one second.

**i. `~` is not expanded.** `cmd.exe` does not expand `~`; a `.env` line like
`INFAGENT_WEIGHTS_DIR=~/models` therefore creates a literal `~` folder on
Windows. *Fix:* one `expandHome()` helper applied to the three directory env
vars (`INFAGENT_MODELS_DIR`, `INFAGENT_WEIGHTS_DIR`, `INFAGENT_SETTINGS_DIR`).

**j. README: a "Windows and Linux" section** — the platform matrix
(`screen_shot` backends: PowerShell on Windows, `scrot`/`import`/`grim`/xvfb on
Linux; the system-info scripts' partial output on Windows; `INFAGENT_PYTHON`),
plus the corrected `#`-comment story so it is not rediscovered.

**k. Optional: a CI matrix** (`windows-latest` + `ubuntu-latest` running
`npm ci && npm run verify`). It needs a workflow file, and the current token is
refused for `.github/workflows/*` — so this waits for a token with `workflow`
scope, or stays a manual checklist.

---

## 3. Design rule for every fix

Platform branches are **pure functions with an injectable platform**
(`resolveCommand(cmd, { platform, env })`, `killArgs(pid, platform)`,
`expandHome(p, { home, platform })`), never `if (process.platform === 'win32')`
buried in a code path. That is what makes Windows behaviour testable from this
Linux sandbox: the tests set `platform: 'win32'` and assert the resolved command
and arguments. The existing `tests/platform.test.ts` +
`tests/portability.test.ts` get the new cases; a `win32`-only test stays
`it.runIf(process.platform === 'win32')` as it is today.

## 4. Verification

**Here (Linux, this sandbox):** `npx tsc --noEmit` · `npm run lint` · `npx vitest
run` · `npm run ui:build` · a live chat turn through `node dist/cli.js serve`
(startup line, one tool call, one final answer) — the full gate, after every
phase.

**On your machine (Windows):** a short checklist I will put in the PR
description and in the README:

```bat
npm ci && npm run ui:install && npm run ui:build
npm test                     :: the /tmp fix
node dist\cli.js serve --port 8787 --host 0.0.0.0     :: the UI line, the browser loads the app
node dist\cli.js chat ask "list my scripts" --no-tools  :: model answers
:: MCP: node dist\cli.js mcp list  → filesystem/fetch/sqlite reach "ready" (sqlite proves the py launcher)
:: .env: Config tab → Save twice in a row (the rename fix)
```

Anything that still misbehaves comes back to me with the exact command and
output, and it gets fixed the same way: a seam + a test + a checklist line.

## 5. Files touched

| Phase | Files | Change |
| --- | --- | --- |
| 1 | `src/mcp/client.ts`, `src/platform/*.ts` *(new, 3 small helpers)*, `src/cli.ts` | command resolution, tree kill, startup line |
| 2 | `tests/chat.test.ts`, `tools/ui-smoke.mjs`, `src/config/envFile.ts` | tmpdir, repo-relative default, rename hardening |
| 3 | `scripts/net_interfaces.py`, `src/config/paths.ts`, `README.md` | lazy `fcntl`, portable interface listing, `~` expansion, docs |
| tests | `tests/platform.test.ts`, `tests/portability.test.ts`, `tests/mcp.test.ts` | win32 seams covered on Linux |

No new dependency: everything above is `node:path`, `node:child_process` and two
`spawnSync` probes.

## 6. Risks

* I cannot run Windows here. Every Windows branch is therefore covered by a
  seam-level unit test plus your checklist line — no claim of "tested on
  Windows" will be made in the commit message.
* `taskkill /T` needs a **pid**, and a killed shim can leave a lock for a moment;
  the stop path retries once and reports the failure instead of pretending.
* The `.env` rename fallback (unlink + rename) is not atomic for a few
  milliseconds; it is used only on `win32`, where the alternative is a failed
  save. If you would rather keep atomicity on Windows, say so and I will use a
  write-through-file strategy instead.

## 7. Order of work

1. Phase 1 (a, b, h) → commit `fix(mcp,cli): start and stop MCP servers on Windows…`
2. Phase 2 (d, e, f) → commit `fix(tests, env): …`
3. Phase 3 (c, g, i, j) → commit `fix(scripts, docs): …`
4. Gate, then push to **QChat main** and `InfAgent main` (the token, please — the
   one in your last message did not survive into this session).

Say **go** (and paste the token) and I start with Phase 1.

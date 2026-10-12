# Proposed skills — nothing added yet

Skills are the *how*: a short procedure the agent loads with `readSkill` when it
is needed. Only one line each goes in the prompt (name + description + when), so
ten more skills cost ≈ 300 tokens per turn. Current: **2** (`web-research`,
`disk-hygiene`).

**Read-only (safe, 7)** — they only call tools that cannot change anything:

| # | name | what it does | when it fires |
| --- | --- | --- | --- |
| 1 | `folder-inventory` | lists one folder per call and counts several of them | "how many files in these folders" |
| 2 | `machine-health` | system_info + disk_report in one step, worst finding first | "is my machine ok / why is it slow" |
| 3 | `network-check` | default route, address, error counters | "what's my IP / am I online" |
| 4 | `screenshot-capture` | screen_shot for a page (`url`) or the desktop | "show me / capture / screenshot" |
| 5 | `sqlite-inspection` | list → describe → one bounded `read_query` | questions about the demo database |
| 6 | `supabase-inspection` | search_docs / list_tables / one read-only SELECT | questions about the Supabase project |
| 7 | `repo-search` | search_files + read_file inside the allowed roots | "where is X in the repo" |

**Write-capable (3)** — they create files or push, each step is checked:

| # | name | what it does | when it fires |
| --- | --- | --- | --- |
| 8 | `script-authoring` | `createScript` + runs it once to prove it works | a task needs a tool that does not exist |
| 9 | `skill-authoring` | `createSkill` for a procedure that will repeat | "remember how to do this" |
| 10 | `git-ship` | status → commit → push to QChat `main` (never force) | "commit and push" |

---

## 1. folder-inventory

```markdown
---
name: folder-inventory
description: List and count files across several folders.
when: The user names two or more folders, or asks how many files are in them.
---

1. One `list_files` call per folder, `{"path":"<the folder>"}` — exactly the
   arguments the user gave, no pattern and no filter of your own.
2. Several folders may go in one step (up to four calls).
3. Never count a folder you did not list, and never list one twice.
4. Read `count` and `totals.files` from each result; a result that reports
   `filtered_out` or `truncated` is not a whole count.
5. The engine adds the same number up and appends the total — quote that number,
   do not compute a second one.
6. If one folder failed, name it and give the total of the ones that worked.
```

## 2. machine-health

```markdown
---
name: machine-health
description: One health check — CPU, memory, disk and uptime — worst finding first.
when: The user asks whether the machine is healthy, why it is slow, or for a status check.
---

1. Call `system_info` with `{"cpu_load":true,"top_processes":5}` and `disk_report`
   in the same step.
2. Report load, memory used/total, uptime, and the mount with the least free space.
3. Flag only what is a real problem: load well above the core count, a mount under
   10% free, a disk that is missing.
4. Asked why it is slow? Name the heaviest process from `top_processes`.
5. Every number must come from the results — never from memory.
```

## 3. network-check

```markdown
---
name: network-check
description: Report the default route, addresses and error counters of the interfaces.
when: The user asks about connectivity, their IP, or which interface is in use.
---

1. Call `net_interfaces` with `{"addresses":true,"traffic":true,"down":true}`.
2. Name the interface that carries the default route, with its IPv4 address and
   its rx/tx totals.
3. A down interface is normal on a laptop (wlan down when wired) — say that
   instead of calling it a fault.
4. The one thing worth flagging is non-zero error or drop counters.
5. One line per interface, the important one first.
```

## 4. screenshot-capture

```markdown
---
name: screenshot-capture
description: Capture a web page or the desktop and report where the image was saved.
when: The user asks for a screenshot, a capture, or "show me" a page.
---

1. A page: `screen_shot` with `{"url":"<address>","full":true}`. The desktop:
   no `url` (needs a display; without one the script says so — report that).
2. Pass `name` when the user named the shot (`"homepage"`), otherwise keep the
   timestamp the script chooses.
3. The image lands in `./screenshot/`, or in the `out` folder you passed; leave
   `keep` at its default.
4. Answer with the saved path exactly as the tool reported it — never claim a
   capture you did not take.
5. Do not describe what the image shows unless the user asks.
```

## 5. sqlite-inspection

```markdown
---
name: sqlite-inspection
description: Inspect the configured SQLite databases with bounded read-only queries.
when: The user asks what is in the database, its tables, or its rows.
---

1. `list_databases` first: the aliases and whether each file is writable.
2. `list_tables` (alias `demo` unless the user says otherwise), then
   `describe_table` for the table you need.
3. `read_query` one statement at a time: `SELECT … FROM … LIMIT …`; pass every
   value through `params` with `?` placeholders — never paste it into the SQL.
4. Rows, bytes and time are capped: a huge result is refused. Select the columns
   and the rows the question needs.
5. This server is read-only — there is no `write_query` here. Never promise a
   change, and say the query is read-only.
6. Answer with the columns and the few rows that matter; keep the SQL out of it.
```

## 6. supabase-inspection

```markdown
---
name: supabase-inspection
description: Answer questions about a Supabase project with read-only queries.
when: The user asks about their Supabase tables, schema, migrations or extensions.
---

1. `search_docs` when the API or the feature is unclear — it searches the
   Supabase documentation.
2. `list_tables` for the schema, then `execute_sql` with a single read-only
   `SELECT` that has a `LIMIT`.
3. `list_migrations` shows what changed and when; `list_extensions` what is
   installed.
4. The connection is read-only: a write comes back refused (`read-only
   transaction`). Report that as it is — never retry it as a read, never present
   a write as done.
5. A failed query: quote the error, try one narrower query, then stop and say
   what is missing.
```

## 7. repo-search

```markdown
---
name: repo-search
description: Find a file, a string or a symbol inside the folders this agent may read.
when: The user asks where something is defined, used, or how a file looks.
---

1. `list_allowed_roots` once — the readable folders (`scripts/`, `skills/`,
   `screenshot/`). Nothing outside them can be opened.
2. `search_files` with the literal string or a regex to find where it lives.
3. `read_file` for one file, `read_multiple_files` when two or three matter,
   `get_file_info` for size and dates.
4. Quote `path:line` and the shortest excerpt that proves the point.
5. If it is not inside the allowed roots, say which folder you would need instead
   of guessing what the file contains.
```

## 8. script-authoring *(creates a file)*

```markdown
---
name: script-authoring
description: Create a new agent script when no existing one fits, and prove it runs.
when: A task needs a tool that does not exist yet, or the user asks for a new script.
---

1. `listScripts` first — if an existing script does the job, use it instead.
2. `createScript` with a lowercase slug, `language` `py` or `js`, a one-line
   description, and the body.
3. The body must: take its arguments as one JSON object (the header lists them),
   print exactly one JSON envelope on stdout — `{"ok":true,"result":…}` or
   `{"ok":false,"error":"…"}` — and nothing else. No shell, no secrets, no
   absolute paths to other people's files.
4. Read the created script back and run it once with a harmless argument to prove
   it works.
5. Report its name and one-line usage. If it failed, fix it or say plainly what
   is broken — never leave a broken script behind silently.
```

## 9. skill-authoring *(creates a file)*

```markdown
---
name: skill-authoring
description: Turn a procedure that will repeat into a skill.
when: The user says to remember how something is done, or the same steps are asked for twice.
---

1. Only for something that will repeat — a one-off answer is not a procedure.
2. `createSkill` with a lowercase slug, a one-line description, a short `when`
   line, and numbered steps as the body.
3. Name the real tools and the order to use them, and say how to know it worked.
4. Keep it under ~15 lines: only name, description and `when` reach the prompt;
   the body is loaded on demand.
5. `listSkills` afterwards to confirm it is registered.
```

## 10. git-ship *(commits and pushes)*

```markdown
---
name: git-ship
description: Commit the current changes and push them to the QChat main branch.
when: The user asks to commit, push, or ship the current work.
---

1. `git status` and read what is about to be committed. Never add a file you have
   not looked at.
2. Never commit secrets or machine-only files: `.env`, `env.txt`, tokens,
   `*.gguf`, `node_modules/`.
3. Commit message: one imperative line saying what changed and why. No backticks.
4. Push `main` to the QChat remote only, via the credential helper. Never
   force-push and never rewrite history; if the push is rejected, stop and report
   it rather than making it go through.
5. Verify both ends afterwards — local `git log -1 --oneline` and the remote's
   main SHA — and report them.
```

---

## Notes before you choose

- 8–10 write to disk or the network; 1–7 cannot change anything.
- Skills 5 and 6 need the `sqlite` and `supabase` MCP servers (both already
  enabled in `mcp.json`); 7 needs the `filesystem` server (enabled, read-only).
- Nothing here needs a code change — skills are data files in `skills/`.
- Adding all ten costs ≈ 300 tokens on every turn. If that bothers you on the
  0.6B model, pick the read-only set first, or drop 5–6 when you are offline.

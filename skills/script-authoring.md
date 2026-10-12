---
name: script-authoring
description: Create a new agent script when no existing one fits, and prove it runs.
when: A task needs a tool that does not exist yet, or the user asks for a new script.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Script authoring

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

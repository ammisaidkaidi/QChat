# Skills

A skill is one markdown file describing **how** to do something: the steps the
agent should follow, the tools to use, and the order to use them in.

```
skills/web-research.md        → research with webSearch/webFetch and cite sources
skills/disk-hygiene.md        → check disk space and propose cleanups
skills/folder-inventory.md    → list and count files across several folders
skills/machine-health.md      → CPU, memory, disk and uptime in one check
skills/network-check.md       → default route, addresses, error counters
skills/screenshot-capture.md  → capture a page or the desktop
skills/sqlite-inspection.md   → read-only queries over the SQLite aliases
skills/supabase-inspection.md → read-only questions about a Supabase project
skills/repo-search.md         → find a file or a string in the allowed roots
skills/script-authoring.md    → create a script and prove it runs
skills/skill-authoring.md     → turn a repeating procedure into a skill
skills/git-ship.md            → commit and push to QChat main
```

The last three create files or push a branch; the rest only read. Skills 5–7 need
the `sqlite`, `supabase` and `filesystem` MCP servers (all enabled in `mcp.json`).

## File format

```markdown
---
name: web-research
description: One line shown to the model.
when: When this skill should be used.
updatedAt: 2026-10-11T00:00:00.000Z
---

1. Step one.
2. Step two.
```

Only `name`, `description` and `when` are put in the prompt up front — the body
is loaded with the `readSkill` tool when the skill is actually needed, which
keeps a small model's context free. Skills can be created from the interface,
by the agent itself (`createSkill`), or by dropping a `.md` file in here.

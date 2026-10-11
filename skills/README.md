# Skills

A skill is one markdown file describing **how** to do something: the steps the
agent should follow, the tools to use, and the order to use them in.

```
skills/web-research.md    → research with webSearch/webFetch and cite sources
skills/disk-hygiene.md    → check disk space and propose cleanups
```

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

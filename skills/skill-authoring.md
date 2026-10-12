---
name: skill-authoring
description: Turn a procedure that will repeat into a skill.
when: The user says to remember how something is done, or the same steps are asked for twice.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Skill authoring

1. Only for something that will repeat — a one-off answer is not a procedure.
2. `createSkill` with a lowercase slug, a one-line description, a short `when`
   line, and numbered steps as the body.
3. Name the real tools and the order to use them, and say how to know it worked.
4. Keep it under ~15 lines: only name, description and `when` reach the prompt;
   the body is loaded on demand.
5. `listSkills` afterwards to confirm it is registered.

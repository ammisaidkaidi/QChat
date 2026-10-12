---
name: git-ship
description: Commit the current changes and push them to the QChat main branch.
when: The user asks to commit, push, or ship the current work.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Git ship

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

---
name: repo-search
description: Find a file, a string or a symbol inside the folders this agent may read.
when: The user asks where something is defined, used, or how a file looks.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Repo search

1. `list_allowed_roots` once — the readable folders (`scripts/`, `skills/`,
   `screenshot/`). Nothing outside them can be opened.
2. `search_files` with the literal string or a regex to find where it lives.
3. `read_file` for one file, `read_multiple_files` when two or three matter,
   `get_file_info` for size and dates.
4. Quote `path:line` and the shortest excerpt that proves the point.
5. If it is not inside the allowed roots, say which folder you would need instead
   of guessing what the file contains.

---
name: supabase-inspection
description: Answer questions about a Supabase project with read-only queries.
when: The user asks about their Supabase tables, schema, migrations or extensions.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Supabase inspection

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

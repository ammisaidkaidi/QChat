---
name: sqlite-inspection
description: Inspect the configured SQLite databases with bounded read-only queries.
when: The user asks what is in the database, its tables, or its rows.
updatedAt: 2026-10-12T00:00:00.000Z
---

# Sqlite inspection

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

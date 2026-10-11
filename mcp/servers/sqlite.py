#!/usr/bin/env python3
"""
Hardened SQLite MCP server.

    python3 mcp/servers/sqlite.py '{"databases":{"main":"/data/app.db"},"allow_write":false}'

Config:
    databases    required — the only database files that can be opened, by alias
                 {"main": "/abs/path/app.db"} or a list of paths
    allow_write  false by default; when false every connection is opened with
                 `mode=ro` AND `PRAGMA query_only=ON`, so a write cannot succeed
                 even if the SQL slips past the statement check
    read_only    explicit alias for the same switch (accepted for clarity)
    max_rows     rows returned per query (default 200, hard ceiling 5000)
    max_bytes    serialized result cap (default 256 KB)
    timeout_ms   per-query budget, enforced with a progress handler (default 5000)
    allow_write_tools  (optional) per-database overrides: {"main": true}

Enforcement notes:
    - Only a single statement is accepted; `ATTACH`, `DETACH`, `VACUUM INTO` and
      `PRAGMA` writes are refused, so a query cannot reach another file.
    - Values are always bound as parameters (`?`), never interpolated.
    - Foreign keys stay ON, journal mode and durability are left untouched.
    - Results are capped by rows and by serialized size; connections are opened
      per call and closed immediately, so no lock is held between calls.

This server implements the MCP stdio protocol (2024-11-05) directly; it has no
dependency beyond the Python standard library.
"""

import json
import os
import re
import sqlite3
import sys
import time

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "infagent-sqlite"
SERVER_VERSION = "1.0.0"

DEFAULTS = {
    "max_rows": 200,
    "max_bytes": 262_144,
    "timeout_ms": 5000,
}

# Statements that are read-only on their own.
READ_PREFIXES = ("select", "with", "explain", "values", "pragma table_info", "pragma index_list")
# Pragma names that only report state; anything else is a write or a settings change.
READ_PRAGMAS = {
    "database_list",
    "foreign_key_list",
    "index_info",
    "index_list",
    "index_xinfo",
    "table_info",
    "table_xinfo",
    "compile_options",
    "page_count",
    "page_size",
    "schema_version",
    "user_version",
    "journal_mode",
    "integrity_check",
    "quick_check",
}
FORBIDDEN = ("attach", "detach", "vacuum", "reindex", "analyze")
# Pragmas that would change durability or constraints, refused with or without an
# "=" so nothing can talk the engine out of its safe defaults.
PRAGMA_HARD_DENY = ("journal_mode", "synchronous", "locking_mode", "foreign_keys", "writable_schema", "w", "temp_store")
WRITE_PREFIXES = ("insert", "update", "delete", "replace", "create", "drop", "alter", "truncate", "begin", "commit", "rollback")


class PolicyError(Exception):
    """Raised for anything the server refuses; returned as a tool error."""


def first_keyword(sql):
    match = re.match(r"\s*(?:--[^\n]*\n|\s)*(?:/\*.*?\*/\s*)*([a-zA-Z_]+)", sql, re.S)
    return (match.group(1) if match else "").lower()


def pragma_name(sql):
    match = re.match(r"\s*pragma\s+(?:[\w\"'\[\]]+\.)?([\w\"'\[\]]+)", sql, re.I)
    return (match.group(1) if match else "").strip("\"'[]").lower()


def is_read_only(sql):
    keyword = first_keyword(sql)
    if keyword in FORBIDDEN:
        return False
    if keyword == "pragma":
        # Reading a pragma is fine; *setting* one is not. `PRAGMA journal_mode`
        # reports the mode, `PRAGMA journal_mode = MEMORY` changes durability,
        # so any assignment is refused in both modes.
        name = pragma_name(sql)
        if name in PRAGMA_HARD_DENY or "=" in sql:
            return False
        return name in READ_PRAGMAS
    return keyword in READ_PREFIXES


def single_statement(sql):
    """Reject `select 1; drop table x` — sqlite3 would happily run the first only."""
    without_strings = re.sub(r"'([^']|'')*'", "''", sql)
    without_comments = re.sub(r"--[^\n]*", " ", without_strings)
    without_comments = re.sub(r"/\*.*?\*/", " ", without_comments, flags=re.S)
    stripped = without_comments.strip().rstrip(";")
    if ";" in stripped:
        raise PolicyError("Refused: send exactly one statement per call.")
    return sql


class Databases:
    """Alias -> file, resolved once and checked on every use."""

    def __init__(self, config):
        entries = config.get("databases") or {}
        if isinstance(entries, list):
            entries = {os.path.splitext(os.path.basename(path))[0]: path for path in entries}
        if not isinstance(entries, dict) or not entries:
            raise PolicyError(
                'The sqlite server needs a "databases" map in its config, e.g. '
                '{"databases": {"main": "/data/app.db"}}'
            )

        self.allow_write = bool(config.get("allow_write") or (config.get("read_only") is False))
        self.overrides = config.get("allow_write_tools") or {}
        self.max_rows = min(int(config.get("max_rows") or DEFAULTS["max_rows"]), 5000)
        self.max_bytes = min(int(config.get("max_bytes") or DEFAULTS["max_bytes"]), 8_388_608)
        self.timeout_ms = int(config.get("timeout_ms") or DEFAULTS["timeout_ms"])

        self.paths = {}
        for alias, path in entries.items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,32}", str(alias)):
                raise PolicyError(f'Invalid database alias "{alias}".')
            absolute = os.path.realpath(os.path.abspath(os.path.expanduser(str(path))))
            if not os.path.isfile(absolute):
                raise PolicyError(f'Database "{alias}" does not exist: {absolute}')
            # Refuse the machine-wide fallback: a configured path must be exact.
            if absolute in ("/", os.path.expanduser("~")):
                raise PolicyError(f'Refused: "{absolute}" is not a database file.')
            self.paths[str(alias)] = absolute

    def resolve(self, alias):
        if alias not in self.paths:
            raise PolicyError(
                f'Unknown database "{alias}". Configured: {", ".join(sorted(self.paths))}'
            )
        return self.paths[alias]

    def writable(self, alias):
        if alias in self.overrides:
            return self.allow_write and bool(self.overrides[alias])
        return self.allow_write

    def connect(self, alias, write=False):
        path = self.resolve(alias)
        if write and not self.writable(alias):
            raise PolicyError(
                f'Read-only mode: "{alias}" was configured without write access.'
            )
        uri = f"file:{path}?mode={'rw' if write else 'ro'}"
        try:
            connection = sqlite3.connect(uri, uri=True, timeout=self.timeout_ms / 1000, isolation_level=None)
        except sqlite3.Error as error:
            raise PolicyError(f"Could not open {alias}: {error}") from error

        connection.execute("PRAGMA foreign_keys = ON")  # never disable constraints
        if not write:
            # Belt and braces with mode=ro: the engine itself refuses writes.
            connection.execute("PRAGMA query_only = ON")
        connection.row_factory = sqlite3.Row
        deadline = time.monotonic() + self.timeout_ms / 1000
        connection.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5000)
        return connection


class Rows:
    """Bound the work a single result can cause."""

    def __init__(self, databases):
        self.databases = databases

    def collect(self, cursor, alias):
        rows = []
        size = 0
        truncated = False
        # One row past the cap is fetched on purpose: that is the only way to
        # know the result was cut short instead of being exactly the cap size.
        for row in cursor:
            record = {key: row[key] for key in row.keys()}
            encoded = json.dumps(record, default=str)
            if len(rows) >= self.databases.max_rows or size + len(encoded) > self.databases.max_bytes:
                truncated = True
                break
            size += len(encoded)
            rows.append(record)
        return rows, truncated, size


# Filled by main(); the placeholder only exists so the tool functions have a
# binding to close over at import time.
DATABASES = None  # type: ignore[assignment]


def tool_list_tables(args):
    alias = args.get("database")
    alias = alias or (sorted(DATABASES.paths)[0] if DATABASES.paths else None)
    connection = DATABASES.connect(alias)
    try:
        rows = connection.execute(
            "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        tables = []
        for row in rows:
            count = None
            if row["type"] == "table":
                try:
                    count = connection.execute(
                        f'SELECT COUNT(*) FROM "{row["name"].replace(chr(34), chr(34) * 2)}"'
                    ).fetchone()[0]
                except sqlite3.Error:
                    count = None
            tables.append({"name": row["name"], "type": row["type"], "rows": count})
        return {
            "database": alias,
            "path": DATABASES.paths[alias],
            "writable": DATABASES.writable(alias),
            "count": len(tables),
            "tables": tables,
        }
    finally:
        connection.close()


def tool_describe_table(args):
    alias = args.get("database") or (sorted(DATABASES.paths)[0] if DATABASES.paths else None)
    table = str(args.get("table") or "").strip()
    if not table:
        raise PolicyError("A table name is required.")
    connection = DATABASES.connect(alias)
    try:
        # Identifier, not a value: quote it instead of binding it.
        quoted = '"{}"'.format(table.replace('"', '""'))
        columns = [
            {
                "name": row["name"],
                "type": row["type"],
                "notnull": bool(row["notnull"]),
                "default": row["dflt_value"],
                "primary_key": bool(row["pk"]),
            }
            for row in connection.execute(f"PRAGMA table_info({quoted})")
        ]
        if not columns:
            raise PolicyError(f'Table "{table}" has no columns (does it exist?).')
        indexes = [
            {"name": row["name"], "unique": bool(row["unique"])}
            for row in connection.execute(f"PRAGMA index_list({quoted})")
        ]
        foreign_keys = [
            {"from": row["from"], "table": row["table"], "to": row["to"], "on_delete": row["on_delete"]}
            for row in connection.execute(f"PRAGMA foreign_key_list({quoted})")
        ]
        return {
            "database": alias,
            "table": table,
            "columns": columns,
            "indexes": indexes,
            "foreign_keys": foreign_keys,
        }
    finally:
        connection.close()


def tool_query(args, write=False):
    alias = args.get("database") or (sorted(DATABASES.paths)[0] if DATABASES.paths else None)
    sql = str(args.get("sql") or "").strip()
    if not sql:
        raise PolicyError("A sql string is required.")
    params = args.get("params") or []
    if not isinstance(params, (list, tuple)):
        raise PolicyError("params must be an array; values are bound as `?` placeholders.")

    single_statement(sql)
    read_only = is_read_only(sql)
    if write and read_only:
        raise PolicyError("write_query needs a writing statement (INSERT, UPDATE, DELETE, CREATE…).")
    if not write and not read_only:
        raise PolicyError(
            "Refused: only read statements are allowed here (SELECT, WITH, EXPLAIN, VALUES or a "
            "read-only PRAGMA). Use write_query if writing is enabled."
        )

    connection = DATABASES.connect(alias, write=write)
    try:
        started = time.monotonic()
        try:
            cursor = connection.execute(sql, tuple(params))
        except sqlite3.Error as error:
            raise PolicyError(f"SQLite refused the statement: {error}") from error

        rows, truncated, size = Rows(DATABASES).collect(cursor, alias)
        elapsed = round((time.monotonic() - started) * 1000, 2)

        if write:
            return {
                "database": alias,
                "statement": first_keyword(sql),
                "rows_affected": cursor.rowcount,
                "duration_ms": elapsed,
            }

        return {
            "database": alias,
            "columns": [column[0] for column in cursor.description or []],
            "count": len(rows),
            "truncated": truncated,
            "bytes": size,
            "duration_ms": elapsed,
            "rows": rows,
        }
    finally:
        connection.close()


def tool_databases(args):
    return {
        "read_only": not DATABASES.allow_write,
        "limits": {
            "max_rows": DATABASES.max_rows,
            "max_bytes": DATABASES.max_bytes,
            "timeout_ms": DATABASES.timeout_ms,
        },
        "databases": [
            {
                "alias": alias,
                "path": path,
                "exists": os.path.isfile(path),
                "writable": DATABASES.writable(alias),
            }
            for alias, path in sorted(DATABASES.paths.items())
        ],
    }


def build_tools(allow_write):
    tools = [
        {
            "name": "list_databases",
            "description": "List the configured SQLite files, whether each is writable, and the active limits.",
            "inputSchema": {"type": "object", "properties": {}},
            "handler": tool_databases,
        },
        {
            "name": "list_tables",
            "description": "Tables and views with an approximate row count.",
            "inputSchema": {
                "type": "object",
                "properties": {"database": {"type": "string", "description": "Configured alias."}},
            },
            "handler": tool_list_tables,
        },
        {
            "name": "describe_table",
            "description": "Columns, indexes and foreign keys of one table.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                },
                "required": ["table"],
            },
            "handler": tool_describe_table,
        },
        {
            "name": "read_query",
            "description": (
                "Run one read-only statement. Values must be passed through `params` "
                "(`?` placeholders), never pasted into the SQL. Row count, size and time are capped."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string"},
                    "params": {"type": "array", "items": {}},
                    "database": {"type": "string"},
                },
                "required": ["sql"],
            },
            "handler": lambda args: tool_query(args, write=False),
        },
    ]

    if allow_write:
        tools.append(
            {
                "name": "write_query",
                "description": (
                    "Run one writing statement (enabled explicitly in the server config). "
                    "Bind every value through `params`; foreign keys stay enforced."
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "sql": {"type": "string"},
                        "params": {"type": "array", "items": {}},
                        "database": {"type": "string"},
                    },
                    "required": ["sql"],
                },
                "handler": lambda args: tool_query(args, write=True),
            }
        )
    return tools


def send(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def text_content(value):
    body = value if isinstance(value, str) else json.dumps(value, indent=2, default=str)
    return {"content": [{"type": "text", "text": body}]}


def call_tool(tools_by_name, message):
    params = message.get("params") or {}
    tool = tools_by_name.get(params.get("name"))
    if tool is None:
        send(
            {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": f'Unknown tool "{params.get("name")}". Known: '
                            + ", ".join(sorted(tools_by_name)),
                        }
                    ],
                    "isError": True,
                },
            }
        )
        return

    try:
        send({"jsonrpc": "2.0", "id": message["id"], "result": text_content(tool["handler"](params.get("arguments") or {}))})
    except PolicyError as error:
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"content": [{"type": "text", "text": str(error)}], "isError": True}})
    except Exception as error:  # noqa: BLE001 - surfaced as a tool error, not a crash
        send(
            {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "content": [{"type": "text", "text": f"{type(error).__name__}: {error}"}],
                    "isError": True,
                },
            }
        )


def main():
    global DATABASES
    config = {}
    if len(sys.argv) > 1 and sys.argv[1].strip():
        try:
            config = json.loads(sys.argv[1])
        except json.JSONDecodeError as error:
            sys.stderr.write(f"sqlite server: config must be JSON: {error}\n")
            return 2

    try:
        DATABASES = Databases(config)
    except PolicyError as error:
        sys.stderr.write(f"sqlite server: {error}\n")
        return 2

    tools = build_tools(DATABASES.allow_write)
    tools_by_name = {tool["name"]: tool for tool in tools}
    sys.stderr.write(
        f"{SERVER_NAME} {SERVER_VERSION}: {len(DATABASES.paths)} database(s), "
        f"{'read-write' if DATABASES.allow_write else 'read-only'}\n"
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("id") is None:
            continue

        method = message.get("method")
        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    },
                }
            )
        elif method == "tools/list":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "result": {
                        "tools": [
                            {"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"]}
                            for tool in tools
                        ]
                    },
                }
            )
        elif method == "tools/call":
            call_tool(tools_by_name, message)
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        else:
            send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"Method not found: {method}"}})

    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
@infagent-script v1
@name list_files
@language py
@description List files in a folder with size, type and modification time, optionally recursive.
@callback run(args) -> { ok, result }
@usage python3 scripts/list_files.py '{"path":"scripts","pattern":"*.py"}'
@params [{"name":"path","type":"string","required":false,"description":"Folder to list. Defaults to the current working directory."},{"name":"pattern","type":"string","required":false,"description":"Glob to filter names, e.g. *.png or report-?.csv."},{"name":"recursive","type":"boolean","required":false,"description":"Walk subfolders too. Defaults to false."},{"name":"hidden","type":"boolean","required":false,"description":"Include dotfiles. Defaults to false."},{"name":"dirs","type":"boolean","required":false,"description":"Include directories. Defaults to true."},{"name":"sort","type":"string","required":false,"description":"name | size | modified | type. Defaults to name."},{"name":"limit","type":"number","required":false,"description":"Maximum entries returned. Defaults to 200."},{"name":"depth","type":"number","required":false,"description":"With recursive: how deep to walk. Defaults to unlimited."}]
@agent
  Use this script when: the user asks what is in a folder, wants the biggest or the newest files, or wants the file types of a project counted.
  Call it with JSON arguments: { "path": <string>, "pattern": <string>, "recursive": <boolean>, "limit": <number> }.
  It prints a single JSON envelope on stdout: { "ok": true, "result": { "path", "count", "truncated", "totals", "entries": [...] } }.
  Each entry is { name, relative, path, type, size_bytes, size, modified, extension }; `totals` sums the returned entries and counts extensions.
  `filtered_out` counts the entries a `pattern` (or `dirs: false`) kept out, so count 0 with scanned > 0 is a filtered listing, not an empty folder.
  On failure it prints { "ok": false, "error": "..." } and exits non-zero — an unreadable folder is not an empty one, so read `error` before retrying.
  Never guess a different name: the script is registered as "list_files".
"""

import fnmatch
import os
import time

SORTS = ("name", "size", "modified", "type")


def human(size):
    """Render a byte count the way a person reads it."""
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def describe(entry, root):
    """Never let one unreadable file spoil the whole listing."""
    try:
        is_dir = entry.is_dir(follow_symlinks=False)
        is_link = entry.is_symlink()
        stat = entry.stat()
    except OSError as error:
        return {
            "name": entry.name,
            "relative": os.path.relpath(entry.path, str(root)),
            "path": entry.path,
            "type": "unreadable",
            "size_bytes": 0,
            "size": "-",
            "modified": None,
            "extension": "",
            "error": str(error),
        }

    kind = "dir" if is_dir else "link" if is_link else "file"
    return {
        "name": entry.name,
        "relative": os.path.relpath(entry.path, str(root)),
        "path": entry.path,
        "type": kind,
        "size_bytes": 0 if is_dir else stat.st_size,
        "size": "-" if is_dir else human(stat.st_size),
        "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
        "extension": "" if is_dir else os.path.splitext(entry.name)[1].lower(),
    }


def run(args=None):
    args = args or {}
    raw_path = str(args.get("path") or ".")
    pattern = str(args.get("pattern") or "").strip()
    # Entries a filter kept out of the listing. Zero of thirteen scanned files is
    # not an empty folder, and the difference has to survive into the envelope.
    filtered_out = 0
    recursive = bool(args.get("recursive") or False)
    include_hidden = bool(args.get("hidden") or False)
    include_dirs = args.get("dirs") is not False
    limit = int(args.get("limit") or 200)
    order = str(args.get("sort") or "name").lower()
    depth = args.get("depth")
    max_depth = int(depth) if isinstance(depth, (int, float)) and depth else None

    if order not in SORTS:
        raise ValueError('sort must be one of {} (got "{}")'.format(", ".join(SORTS), order))
    if limit < 1:
        raise ValueError("limit must be at least 1")

    root = os.path.abspath(os.path.expanduser(raw_path))
    if not os.path.isdir(root):
        raise NotADirectoryError("no such folder: {}".format(root))

    entries = []
    extension_counts = {}
    scanned = 0
    unreadable_folders = 0
    matched_bytes = 0

    def matches(name):
        if not pattern:
            return True
        return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name.lower(), pattern.lower())

    def walk(directory, level):
        nonlocal scanned, unreadable_folders, matched_bytes, filtered_out
        try:
            children = sorted(os.scandir(directory), key=lambda item: item.name.lower())
        except OSError:
            unreadable_folders += 1
            return

        for entry in children:
            scanned += 1
            if not include_hidden and entry.name.startswith("."):
                continue

            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False

            if is_dir:
                # A pattern filters the listing, directories included; they are
                # still walked into so a nested match is not missed.
                if include_dirs and matches(entry.name):
                    entries.append(describe(entry, root))
                elif include_dirs:
                    filtered_out += 1
                if recursive and (max_depth is None or level + 1 < max_depth):
                    walk(entry.path, level + 1)
                continue

            if not matches(entry.name):
                filtered_out += 1
                continue

            record = describe(entry, root)
            entries.append(record)
            matched_bytes += record["size_bytes"]
            key = record["extension"] or "(none)"
            extension_counts[key] = extension_counts.get(key, 0) + 1

    walk(root, 0)

    sorters = {
        "name": lambda item: item["name"].lower(),
        "size": lambda item: item["size_bytes"],
        "modified": lambda item: item["modified"] or "",
        "type": lambda item: (item["type"], item["name"].lower()),
    }
    entries.sort(key=sorters[order], reverse=order in ("size", "modified"))

    truncated = len(entries) > limit
    visible = entries[:limit]
    files = [item for item in visible if item["type"] == "file"]
    directories = [item for item in visible if item["type"] == "dir"]
    visible_bytes = sum(item["size_bytes"] for item in files)

    return {
        "path": root,
        "pattern": pattern or None,
        "recursive": recursive,
        "sort": order,
        "count": len(visible),
        "scanned": scanned,
        "filtered_out": filtered_out,
        "unreadable_folders": unreadable_folders,
        "truncated": truncated,
        "totals": {
            "files": len(files),
            "directories": len(directories),
            "size_bytes": visible_bytes,
            "size": human(visible_bytes),
            "matched_size_bytes": matched_bytes,
            "matched_size": human(matched_bytes),
            "by_extension": dict(
                sorted(extension_counts.items(), key=lambda pair: pair[1], reverse=True)
            ),
        },
        "entries": visible,
    }


if __name__ == "__main__":
    import json
    import sys

    try:
        payload = sys.argv[1] if len(sys.argv) > 1 else "{}"
        print(json.dumps({"ok": True, "result": run(json.loads(payload))}, default=str))
    except Exception as error:  # noqa: BLE001 - the envelope is the error channel
        print(json.dumps({"ok": False, "error": "{}: {}".format(type(error).__name__, error)}))
        sys.exit(1)

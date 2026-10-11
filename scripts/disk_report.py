"""
@infagent-script v1
@name disk_report
@language py
@description Report free and used disk space for every mounted volume.
@callback run(args) -> { ok, result }
@usage python3 scripts/disk_report.py '{"example":true}'
@params [{"name":"min_free_gb","type":"number","required":false,"description":"Only flag volumes below this free space."}]
@agent
  Use this script when: Report free and used disk space for every mounted volume.
  Call it with JSON arguments: { "min_free_gb": <number> }.
  It prints a single JSON envelope on stdout: { "ok": true, "result": ... }.
  On failure it prints { "ok": false, "error": "..." } and exits non-zero — check the envelope before retrying.
  Never guess a different name: the script is registered as "disk_report".
"""

import shutil


def run(args):
    threshold = float(args.get("min_free_gb") or 0)
    volumes = []
    for mount in ("/", "/home", "/tmp", "/var"):
        try:
            usage = shutil.disk_usage(mount)
        except OSError:
            continue
        free_gb = round(usage.free / 1024**3, 2)
        volumes.append({
            "mount": mount,
            "total_gb": round(usage.total / 1024**3, 2),
            "free_gb": free_gb,
            "used_percent": round(usage.used / usage.total * 100, 1),
            "below_threshold": threshold > 0 and free_gb < threshold,
        })
    return {"volumes": volumes, "count": len(volumes), "threshold_gb": threshold}


if __name__ == "__main__":
    import json
    import sys

    try:
        payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}
        print(json.dumps({"ok": True, "result": run(payload)}, ensure_ascii=False))
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)

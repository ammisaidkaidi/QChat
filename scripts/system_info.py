"""
@infagent-script v1
@name system_info
@language py
@description Report system properties: CPU, memory, disks, uptime, load and temperature.
@callback run(args) -> { ok, result }
@usage python3 scripts/system_info.py '{"disks":true,"cpu_load":true}'
@params [{"name":"disks","type":"boolean","required":false,"description":"Include per-mount disk usage. Defaults to true."},{"name":"cpu_load","type":"boolean","required":false,"description":"Sample /proc/stat for a real usage percentage. Defaults to true."},{"name":"sample_ms","type":"number","required":false,"description":"How long to sample the CPU. Defaults to 250 ms, 0 disables sampling."},{"name":"top_processes","type":"number","required":false,"description":"Also list the N heaviest processes by memory. Defaults to 0 (off)."}]
@agent
  Use this script when: the user asks about the machine — how much RAM is free, how many CPU cores there are, what is slow, how full the disks are or how long the box has been up.
  Call it with JSON arguments: { "disks": <boolean>, "cpu_load": <boolean>, "top_processes": <number> }.
  It prints a single JSON envelope on stdout: { "ok": true, "result": { "host", "cpu", "memory", "disks", "uptime", "kernel", "python" } }.
  Sizes are given twice: raw bytes (`total_bytes`) and human text (`total`), so use the *_bytes fields for arithmetic.
  On failure it prints { "ok": false, "error": "..." } and exits non-zero — a missing /proc entry is reported as an empty section, not an error.
  Never guess a different name: the script is registered as "system_info".
"""

import os
import platform
import shutil
import socket
import sys
import time

GiB = 1024**3
MiB = 1024**2


def human(size):
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def read_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def cpu_info():
    """Model name, core counts and frequency, from /proc/cpuinfo when it exists."""
    text = read_file("/proc/cpuinfo")
    models = {}
    physical_ids = set()
    core_ids = set()
    processors = 0
    mhz = []

    for block in text.strip().split("\n\n"):
        fields = {}
        for line in block.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields[key.strip()] = value.strip()
        if not fields:
            continue
        processors += 1
        model = fields.get("model name") or fields.get("Processor") or fields.get("cpu")
        if model:
            models[model] = models.get(model, 0) + 1
        if "physical id" in fields and "core id" in fields:
            physical_ids.add(fields["physical id"])
            core_ids.add((fields["physical id"], fields["core id"]))
        try:
            mhz.append(float(fields.get("cpu MHz", "0")))
        except ValueError:
            pass

    info = {
        "logical_cores": processors or os.cpu_count() or None,
        "physical_cores": len(core_ids) or len(physical_ids) or None,
        "models": [
            {"name": name, "count": count}
            for name, count in sorted(models.items(), key=lambda pair: -pair[1])
        ],
        "architecture": platform.machine(),
        "mhz_current": round(sum(mhz) / len(mhz), 1) if mhz else None,
    }

    try:
        load = os.getloadavg()
        info["load_average"] = {"1m": round(load[0], 2), "5m": round(load[1], 2), "15m": round(load[2], 2)}
        cores = info["logical_cores"] or 1
        info["load_percent_1m"] = round(load[0] / cores * 100, 1)
    except (OSError, AttributeError):
        info["load_average"] = None

    return info


def cpu_usage(sample_ms):
    """Total busy percentage from two /proc/stat samples; None when unavailable."""
    if sample_ms <= 0:
        return None

    def snapshot():
        line = read_file("/proc/stat").split("\n", 1)[0].split()
        if len(line) < 8 or line[0] != "cpu":
            return None
        values = [int(value) for value in line[1:9]]
        idle = values[3] + values[4]  # idle + iowait
        return sum(values), idle

    first = snapshot()
    if first is None:
        return None

    time.sleep(min(max(sample_ms, 50), 2000) / 1000)

    second = snapshot()
    if second is None:
        return None

    total_delta = second[0] - first[0]
    idle_delta = second[1] - first[1]
    if total_delta <= 0:
        return None
    return {
        "busy_percent": round((total_delta - idle_delta) / total_delta * 100, 1),
        "sample_ms": sample_ms,
    }


def memory_info():
    """RAM and swap from /proc/meminfo, with a sysconf fallback."""
    wanted = {
        "MemTotal": "total",
        "MemFree": "free",
        "MemAvailable": "available",
        "Buffers": "buffers",
        "Cached": "cached",
        "SwapTotal": "swap_total",
        "SwapFree": "swap_free",
    }
    values = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.split(":")
        if len(parts) != 2:
            continue
        key = wanted.get(parts[0].strip())
        if not key:
            continue
        number = parts[1].strip().split()[0]
        try:
            values[key] = int(number) * 1024  # kB -> bytes
        except ValueError:
            continue

    if "total" not in values:
        try:
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            values["total"] = pages * page_size
        except (ValueError, OSError, AttributeError):
            return {}

    total = values.get("total", 0)
    available = values.get("available", values.get("free", 0))
    used = max(total - available, 0)
    swap_total = values.get("swap_total", 0)
    swap_free = values.get("swap_free", 0)

    return {
        "total_bytes": total,
        "total": human(total),
        "available_bytes": available,
        "available": human(available),
        "used_bytes": used,
        "used": human(used),
        "used_percent": round(used / total * 100, 1) if total else None,
        "cached_bytes": values.get("cached", 0),
        "buffers_bytes": values.get("buffers", 0),
        "swap_total_bytes": swap_total,
        "swap_total": human(swap_total),
        "swap_free_bytes": swap_free,
        "swap_used_percent": round((swap_total - swap_free) / swap_total * 100, 1) if swap_total else 0,
    }


def disk_info():
    """One row per real mount point, skipping the pseudo filesystems."""
    ignored = (
        "proc",
        "sysfs",
        "tmpfs",
        "devtmpfs",
        "devpts",
        "cgroup",
        "cgroup2",
        "overlay",
        "squashfs",
        "ramfs",
        "securityfs",
        "debugfs",
        "tracefs",
        "fusectl",
        "mqueue",
        "hugetlbfs",
        "pstore",
        "bpf",
        "autofs",
        "binfmt_misc",
        "configfs",
        "efivarfs",
        "rpc_pipefs",
        "nsfs",
    )

    seen = set()
    mounts = []
    for line in read_file("/proc/mounts").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        device, mount, filesystem = parts[0], parts[1], parts[2]
        if filesystem in ignored or mount in seen:
            continue
        if not (device.startswith("/") or device.startswith("UUID=") or ":" in device):
            continue
        seen.add(mount)
        mounts.append((device, mount, filesystem))

    # A container often hides the real mounts; the root is always worth reporting.
    if not any(mount == "/" for _, mount, _ in mounts):
        mounts.insert(0, ("/", "/", "unknown"))

    rows = []
    for device, mount, filesystem in mounts[:20]:
        try:
            usage = shutil.disk_usage(mount)
        except OSError:
            continue
        rows.append(
            {
                "device": device,
                "mount": mount,
                "filesystem": filesystem,
                "total_bytes": usage.total,
                "total": human(usage.total),
                "free_bytes": usage.free,
                "free": human(usage.free),
                "used_bytes": usage.used,
                "used": human(usage.used),
                "used_percent": round(usage.used / usage.total * 100, 1) if usage.total else None,
            }
        )

    rows.sort(key=lambda row: row["used_percent"] or 0, reverse=True)
    lowest = min(rows, key=lambda row: row["free_bytes"]) if rows else None
    return {"mounts": rows, "tightest": lowest["mount"] if lowest else None}


def uptime_info():
    text = read_file("/proc/uptime").split()
    try:
        seconds = float(text[0])
    except (IndexError, ValueError):
        return {"seconds": None}

    now = time.time()
    return {
        "seconds": round(seconds),
        "human": "{}d {}h {}m".format(int(seconds // 86400), int(seconds % 86400 // 3600), int(seconds % 3600 // 60)),
        "boot_time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now - seconds)),
    }


def temperature_info():
    rows = []
    base = "/sys/class/thermal"
    try:
        zones = sorted(os.listdir(base))
    except OSError:
        return rows

    for zone in zones:
        if not zone.startswith("thermal_zone"):
            continue
        raw = read_file(f"{base}/{zone}/temp").strip()
        label = read_file(f"{base}/{zone}/type").strip() or zone
        try:
            celsius = int(raw) / 1000
        except ValueError:
            continue
        rows.append({"zone": label, "celsius": round(celsius, 1)})
    return rows


def heaviest_processes(count):
    """Top processes by resident memory, read straight from /proc."""
    rows = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            stat = os.stat(f"/proc/{entry}")
            status = read_file(f"/proc/{entry}/status")
            name = ""
            rss_kb = 0
            for line in status.splitlines():
                if line.startswith("Name:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("VmRSS:"):
                    rss_kb = int(line.split()[1])
                    break
            if rss_kb:
                rows.append(
                    {
                        "pid": int(entry),
                        "name": name,
                        "rss_bytes": rss_kb * 1024,
                        "rss": human(rss_kb * 1024),
                        "started": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
                    }
                )
        except (OSError, ValueError):
            continue

    rows.sort(key=lambda row: row["rss_bytes"], reverse=True)
    return rows[:count]


def run(args=None):
    args = args or {}
    want_disks = args.get("disks") is not False
    want_cpu_load = args.get("cpu_load") is not False
    sample_ms = int(args.get("sample_ms") or 250)
    top = int(args.get("top_processes") or 0)

    result = {
        "host": {
            "name": socket.gethostname(),
            "fqdn": socket.getfqdn(),
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
            "processor": platform.processor() or None,
            "booted": uptime_info().get("boot_time"),
        },
        "kernel": platform.platform(),
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
            "pid": os.getpid(),
        },
        "cpu": cpu_info(),
        "memory": memory_info(),
        "uptime": uptime_info(),
        "temperature": temperature_info(),
        "path": os.getcwd(),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    if want_cpu_load:
        result["cpu"]["usage"] = cpu_usage(sample_ms)
    else:
        result["cpu"]["usage"] = None

    result["disks"] = disk_info() if want_disks else None
    result["processes"] = {
        "heaviest": heaviest_processes(top) if top > 0 else [],
        "count": len([entry for entry in os.listdir("/proc") if entry.isdigit()])
        if os.path.isdir("/proc")
        else None,
    }

    return result


if __name__ == "__main__":
    import json
    import sys

    try:
        payload = sys.argv[1] if len(sys.argv) > 1 else "{}"
        print(json.dumps({"ok": True, "result": run(json.loads(payload))}, default=str))
    except Exception as error:  # noqa: BLE001 - the envelope is the error channel
        print(json.dumps({"ok": False, "error": "{}: {}".format(type(error).__name__, error)}))
        sys.exit(1)

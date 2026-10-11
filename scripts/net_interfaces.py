"""
@infagent-script v1
@name net_interfaces
@language py
@description List the network interfaces with their state, addresses, traffic counters and the default route.
@callback run(args) -> { ok, result }
@usage python3 scripts/net_interfaces.py '{"addresses":true,"traffic":true}'
@params [{"name":"addresses","type":"boolean","required":false,"description":"Include IPv4/IPv6 addresses and netmasks. Defaults to true."},{"name":"traffic","type":"boolean","required":false,"description":"Include rx/tx byte and error counters. Defaults to true."},{"name":"down","type":"boolean","required":false,"description":"Include interfaces that are down. Defaults to true."},{"name":"name","type":"string","required":false,"description":"Only report one interface, e.g. eth0 or wlan0."}]
@agent
  Use this script when: the user asks which network interfaces exist, their IP addresses, whether the link is up, the MAC address, how much traffic went through, or what the default gateway and DNS servers are.
  Call it with JSON arguments: { "addresses": <boolean>, "traffic": <boolean>, "down": <boolean>, "name": <string> }.
  It prints a single JSON envelope on stdout: { "ok": true, "result": { "interfaces": [...], "default_route", "nameservers", "hostname" } }.
  Each interface is { name, index, state, is_up, mac, mtu, speed_mbps, ipv4: [...], ipv6: [...], traffic: {...} }; a missing driver value is `null`, not an error.
  On failure it prints { "ok": false, "error": "..." } and exits non-zero — check the envelope before retrying.
  Never guess a different name: the script is registered as "net_interfaces".
"""

import fcntl
import os
import socket
import struct
import time

SYS_NET = "/sys/class/net"
SIOCGIFADDR = 0x8915
SIOCGIFNETMASK = 0x891B


def human(size):
    units = ("B", "KB", "MB", "GB", "TB")
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def read(path, default=""):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read().strip()
    except OSError:
        return default


def read_int(path):
    try:
        return int(read(path))
    except ValueError:
        return None


def dotted(network_order):
    """Kernel prints IPv4 as 4 bytes in network order on little-endian boxes."""
    return socket.inet_ntoa(struct.pack("<I", int(network_order, 16)))


def ioctl_query(name, request):
    """IPv4 via ioctl — the only address lookup available without a dependency."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            packed = struct.pack("256s", name[:15].encode("utf-8"))
            return socket.inet_ntoa(fcntl.ioctl(sock.fileno(), request, packed)[20:24])
        except OSError:
            return None


def ipv6_addresses(name):
    """IPv6 lives in /proc/net/if_inet6: address, index, prefix, scope, flags, name."""
    rows = []
    for line in read("/proc/net/if_inet6").splitlines():
        parts = line.split()
        if len(parts) < 6 or parts[5] != name:
            continue
        raw = parts[0]
        groups = [raw[index : index + 4] for index in range(0, len(raw), 4)]
        try:
            address = socket.inet_ntop(socket.AF_INET6, bytes.fromhex(raw))
        except (ValueError, OSError):
            address = ":".join(groups)
        rows.append(
            {
                "address": address,
                "prefix_length": int(parts[2], 16),
                "scope": {
                    "00": "global",
                    "10": "host",
                    "20": "link",
                    "40": "site",
                    "50": "organization",
                    "80": "global",
                }.get(parts[3], parts[3]),
            }
        )
    return rows


def interface_names():
    try:
        entries = sorted(os.listdir(SYS_NET))
    except OSError:
        entries = []
    if entries:
        return entries
    # No sysfs (macOS, Windows, exotic container): ask the socket layer.
    try:
        return [name for _, name in socket.if_nameindex()]
    except (OSError, AttributeError):
        return []


def describe(name, options):
    base = f"{SYS_NET}/{name}"
    state = read(f"{base}/operstate", "unknown")
    flags = read(f"{base}/flags")
    carrier = read_int(f"{base}/carrier")

    mac = read(f"{base}/address")
    if not mac or mac == "00:00:00:00:00:00":
        mac = None

    speed = read_int(f"{base}/speed")
    if speed is None or speed <= 0 or speed >= 2**31:
        # Drivers report -1 or 0xFFFFFFFF when the link is down or the speed is unknown.
        speed = None

    record = {
        "name": name,
        "index": read_int(f"{base}/ifindex"),
        "state": state,
        "is_up": state == "up" or (flags is not None and (int(flags, 16) & 0x1) == 1),
        "carrier": bool(carrier) if carrier is not None else None,
        "mac": mac,
        "mtu": read_int(f"{base}/mtu"),
        "speed_mbps": speed,
        "duplex": read(f"{base}/duplex") or None,
        "kind": "wifi"
        if os.path.islink(f"{base}/phy80211") or os.path.isdir(f"{base}/wireless")
        else "loopback"
        if name == "lo"
        else "ethernet"
        if os.path.islink(f"{base}/device")
        else "virtual",
    }

    if options["addresses"]:
        ipv4 = ioctl_query(name, SIOCGIFADDR)
        mask = ioctl_query(name, SIOCGIFNETMASK)
        record["ipv4"] = (
            [{"address": ipv4, "netmask": mask, "prefix_length": mask and _mask_bits(mask)}]
            if ipv4
            else []
        )
        record["ipv6"] = ipv6_addresses(name)
    else:
        record["ipv4"] = None
        record["ipv6"] = None

    if options["traffic"]:
        stats = f"{base}/statistics"
        rx = read_int(f"{stats}/rx_bytes")
        tx = read_int(f"{stats}/tx_bytes")
        record["traffic"] = {
            "rx_bytes": rx,
            "rx": human(rx) if rx is not None else None,
            "tx_bytes": tx,
            "tx": human(tx) if tx is not None else None,
            "rx_packets": read_int(f"{stats}/rx_packets"),
            "tx_packets": read_int(f"{stats}/tx_packets"),
            "rx_errors": read_int(f"{stats}/rx_errors"),
            "tx_errors": read_int(f"{stats}/tx_errors"),
            "rx_dropped": read_int(f"{stats}/rx_dropped"),
            "tx_dropped": read_int(f"{stats}/tx_dropped"),
        }
    else:
        record["traffic"] = None

    return record


def _mask_bits(mask):
    """255.255.255.0 -> 24, for anyone who wants CIDR notation."""
    try:
        packed = struct.unpack("!I", socket.inet_aton(mask))[0]
    except OSError:
        return None
    return bin(packed).count("1")


def default_route():
    """First line of /proc/net/route with a zero destination is the default."""
    for line in read("/proc/net/route").splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8 or parts[1] != "00000000":
            continue
        try:
            return {
                "interface": parts[0],
                "gateway": dotted(parts[2]),
                "metric": int(parts[6]),
                "flags": parts[3],
            }
        except (ValueError, OSError):
            continue
    return None


def nameservers():
    rows = []
    for line in read("/etc/resolv.conf").splitlines():
        if line.startswith("nameserver"):
            parts = line.split()
            if len(parts) > 1 and parts[1] not in rows:
                rows.append(parts[1])
    return rows


def hostname_addresses():
    """What the machine resolves itself to — often the first useful address."""
    rows = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            address = info[4][0]
            if address not in rows:
                rows.append(address)
    except (socket.gaierror, OSError):
        pass
    return rows


def wifi_signal(name):
    """Signal quality is only reported for wireless interfaces."""
    text = read("/proc/net/wireless")
    for line in text.splitlines():
        if line.strip().startswith(f"{name}:"):
            parts = line.replace(":", " ").split()
            try:
                return {
                    "status": parts[2],
                    "link_quality": parts[3].rstrip("."),
                    "signal_dbm": parts[4].rstrip("."),
                    "noise_dbm": parts[5].rstrip("."),
                }
            except IndexError:
                return None
    return None


def run(args=None):
    args = args or {}
    options = {
        "addresses": args.get("addresses") is not False,
        "traffic": args.get("traffic") is not False,
    }
    include_down = args.get("down") is not False
    only = str(args.get("name") or "").strip()

    names = interface_names()
    if only:
        if only not in names:
            raise ValueError(f'no interface named "{only}" (have: {", ".join(names) or "none"})')
        names = [only]

    interfaces = []
    for name in names:
        record = describe(name, options)
        if not include_down and not record["is_up"]:
            continue
        signal = wifi_signal(name)
        if signal:
            record["wifi"] = signal
        interfaces.append(record)

    interfaces.sort(key=lambda item: (not item["is_up"], item["name"]))

    return {
        "hostname": socket.gethostname(),
        "hostname_addresses": hostname_addresses(),
        "interfaces": interfaces,
        "count": len(interfaces),
        "up_count": len([item for item in interfaces if item["is_up"]]),
        "default_route": default_route(),
        "nameservers": nameservers(),
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
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

"""Best-effort in-process guard for `run_python` (mcp/servers/code.mjs).

    python3 -I -B mcp/lib/pyguard.py <sandbox-dir> <user-file.py>

`-I` (isolated) already ignores `PYTHON*` environment variables and the user
site-packages, and the parent process empties the environment it passes down.
This file adds the rest of the policy for the code that is about to run:

  * an audit hook that refuses **writes outside the sandbox**, **reads outside
    the sandbox and the interpreter's own library**, **process creation**
    (`os.system`, `os.exec*`, `subprocess.Popen`) and **sockets**
    (`socket.connect`, `socket.bind`, `socket.getaddrinfo`);
  * an import block for the modules that could step around those checks in one
    call (`ctypes`, `socket`, `subprocess`, `multiprocessing`, `pty`, …).

Honest limits, stated in the tool description as well: an audit hook runs in the
same interpreter as the code, so this is a guard rail, not a kernel boundary.
A determined program using a language escape the hook cannot see could get past
it. What *is* enforced by the OS is the time limit, the environment (no secrets)
and — where the platform provides `unshare` — the absence of a network.
"""

import os
import runpy
import sys
import sysconfig

SANDBOX = os.path.realpath(sys.argv[1])
TARGET = sys.argv[2]

# Modules that would make the checks below optional: a single call into libc or
# a forked interpreter steps around any Python-level policy.
BLOCKED_MODULES = {
    "ctypes",
    "socket",
    "ssl",
    "subprocess",
    "multiprocessing",
    "pty",
    "fcntl",
    "mmap",
    "signal",
    "resource",
    "webbrowser",
    "http",
    "urllib",
    "ftplib",
    "smtplib",
    "telnetlib",
    "asyncio",
    "importlib",
}

# Audit events that stop a run outright.
BLOCKED_EVENTS = {
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawn",
    "os.fork",
    "os.forkpty",
    "subprocess.Popen",
    "socket.connect",
    "socket.bind",
    "socket.getaddrinfo",
    "socket.gethostbyname",
    "socket.sendto",
    "ctypes.dlopen",
    "ctypes.dlsym",
    "ctypes.addressof",
    "pty.spawn",
}

WRITE_MODES = set("wax+")


def allowed_read_dirs():
    """Where the code may read: its sandbox and the interpreter's own files."""
    dirs = [SANDBOX, os.path.realpath(sys.prefix) if sys.prefix else None]
    for key in ("stdlib", "platstdlib", "purelib", "platlib", "include", "scripts"):
        path = sysconfig.get_paths().get(key)
        if path:
            dirs.append(os.path.realpath(path))
    if sys.base_prefix and sys.base_prefix != sys.prefix:
        dirs.append(os.path.realpath(sys.base_prefix))
    return [path for path in dirs if path]


READ_DIRS = allowed_read_dirs()


def inside(path, root):
    return path == root or path.startswith(root + os.sep)


def allowed_path(path, mode):
    """True when this open() is inside the policy.

    A relative path belongs to the sandbox: the interpreter may be started with
    any working directory, and "out.txt" must always mean the sandbox's.
    """
    raw = str(path)
    if not os.path.isabs(raw):
        raw = os.path.join(SANDBOX, raw)
    try:
        real = os.path.realpath(raw)
    except (OSError, ValueError):
        return False
    if mode and set(mode) & WRITE_MODES:
        return inside(real, SANDBOX)
    return any(inside(real, root) for root in READ_DIRS)


def hook(event, args):
    if event in BLOCKED_EVENTS:
        raise PermissionError(f"{event} is not allowed in this sandbox")
    if event == "import":
        name = str(args[0] or "")
        root = name.split(".")[0]
        if root in BLOCKED_MODULES:
            raise PermissionError(f"import {root} is not allowed in this sandbox")
        return
    if event in ("open", "os.open"):
        path, mode = args[0], args[1]
        if not allowed_path(path, mode if isinstance(mode, str) else ""):
            raise PermissionError(f"{path} is outside the sandbox ({event})")


sys.addaudithook(hook)
sys.argv = [TARGET]

try:
    runpy.run_path(TARGET, run_name="__main__")
except SystemExit as exit_code:  # the code called sys.exit()
    sys.exit(exit_code.code)

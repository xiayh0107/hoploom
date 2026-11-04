"""Stoppable sftp runs and their byte progress, for transfers a caller can cancel.

Cancelling signals sftp alone, never its process group. When this sftp's ssh
starts a shared ControlMaster, the master's ProxyJump child is forked before
the master detaches and stays in this group, while other requests keep using
that master. sftp answers SIGTERM by stopping its own ssh child, whose proxy
and AskPass helpers then see end-of-file. Windows has no shared masters; there
ssh.exe exits when the pipe to the terminated sftp.exe breaks.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

STOP_GRACE_SECONDS = 2
OUTPUT_LIMIT_BYTES = 256 * 1024
POLL_SECONDS = 0.05


class Cancelled(Exception):
    """The caller cancelled; the process was stopped."""


class DeadlineExceeded(Exception):
    """The process outlived its deadline and was stopped."""


def _drain(stream: Any, sink: bytearray) -> None:
    # Keep reading after the limit so the child never blocks on a full pipe.
    with stream:
        while chunk := stream.read1(65536):
            room = OUTPUT_LIMIT_BYTES - len(sink)
            if room > 0:
                sink.extend(chunk[:room])


def _feed(stream: Any, data: bytes) -> None:
    try:
        with stream:
            stream.write(data)
    except (BrokenPipeError, OSError):
        pass  # The child exited or was stopped before reading everything.


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        process.kill()
    else:
        process.terminate()
        try:
            process.wait(timeout=STOP_GRACE_SECONDS)
            return
        except subprocess.TimeoutExpired:
            process.kill()
    process.wait()


def run_stoppable(
    command: list[str],
    *,
    input_text: str,
    env: dict[str, str],
    timeout: float,
    cancel: threading.Event | None = None,
    on_start: Callable[[subprocess.Popen], None] | None = None,
) -> tuple[int, str, str]:
    """Run `command` with captured, bounded output until it exits, times out or is cancelled."""
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    stdout, stderr = bytearray(), bytearray()
    workers = [
        threading.Thread(target=_drain, args=(process.stdout, stdout), daemon=True),
        threading.Thread(target=_drain, args=(process.stderr, stderr), daemon=True),
        threading.Thread(target=_feed, args=(process.stdin, input_text.encode("utf-8")), daemon=True),
    ]
    for worker in workers:
        worker.start()
    outcome: type[Exception] | None = None
    try:
        if on_start is not None:
            on_start(process)
        deadline = time.monotonic() + timeout
        while True:
            try:
                process.wait(timeout=POLL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                pass
            if cancel is not None and cancel.is_set():
                outcome = Cancelled
                break
            if time.monotonic() >= deadline:
                outcome = DeadlineExceeded
                break
    finally:
        # Also reached by an exception from on_start: never leave sftp running.
        stop(process)
        for worker in workers:
            worker.join(timeout=STOP_GRACE_SECONDS)
    if outcome is not None:
        raise outcome()
    return (
        process.returncode,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


# --- how far another process has read a file ---------------------------------
#
# sftp's put reads its local source sequentially, so the read position is the
# number of bytes handed to the SSH connection. It leads the host by at most
# sftp's in-flight requests (64 × 32 KiB by default). Only Linux and macOS
# expose it; elsewhere the answer is "unknown", never an estimate.

_libproc: Any = None


def _darwin_position(pid: int, target: str) -> int | None:
    global _libproc
    if _libproc is None:
        library = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib", use_errno=True)
        library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        library.proc_pidfdinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        _libproc = library

    class FileDescriptor(ctypes.Structure):
        _fields_ = [("proc_fd", ctypes.c_int32), ("proc_fdtype", ctypes.c_uint32)]

    needed = _libproc.proc_pidinfo(pid, 1, 0, None, 0)  # PROC_PIDLISTFDS
    if needed <= 0:
        return None
    descriptors = (FileDescriptor * (needed // ctypes.sizeof(FileDescriptor) + 16))()
    filled = _libproc.proc_pidinfo(pid, 1, 0, descriptors, ctypes.sizeof(descriptors))
    # struct vnode_fdinfowithpath: proc_fileinfo (fi_offset at byte 8, 24
    # bytes), then vnode_info (152 bytes), then the MAXPATHLEN path.
    size, offset_at, path_at = 1200, 8, 176
    for descriptor in descriptors[: max(0, filled) // ctypes.sizeof(FileDescriptor)]:
        if descriptor.proc_fdtype != 1:  # PROX_FDTYPE_VNODE
            continue
        raw = ctypes.create_string_buffer(size)
        if _libproc.proc_pidfdinfo(pid, descriptor.proc_fd, 2, raw, size) != size:  # PROC_PIDFDVNODEPATHINFO
            continue
        if raw.raw[path_at:].split(b"\0", 1)[0] == target.encode():
            return int.from_bytes(raw.raw[offset_at:offset_at + 8], sys.byteorder, signed=True)
    return None


def _linux_position(pid: int, target: str) -> int | None:
    directory = f"/proc/{pid}/fd"
    for name in os.listdir(directory):
        try:
            if os.readlink(f"{directory}/{name}") != target:
                continue
            with open(f"/proc/{pid}/fdinfo/{name}", encoding="ascii") as handle:
                for line in handle:
                    if line.startswith("pos:"):
                        return int(line.split()[1])
        except (OSError, ValueError):
            continue
    return None


def read_position(pid: int, path: str | Path) -> int | None:
    """Bytes process `pid` has read from `path`, or None when it cannot be known."""
    target = os.path.realpath(path)
    try:
        if sys.platform == "darwin":
            return _darwin_position(pid, target)
        if sys.platform.startswith("linux"):
            return _linux_position(pid, target)
    except (OSError, ValueError, AttributeError):
        pass
    return None

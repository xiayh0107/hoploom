"""Foreground OpenSSH masters owned independently of request process groups.

A request leases a master until its operation finishes. Canceling one waiter
releases only its lease; an unfinished handshake is stopped when its last
consumer leaves. Established masters expire after the configured idle reuse
period. One timer manages all idle masters, not one thread per host.
"""
from __future__ import annotations

import hashlib
import threading
import time
import uuid
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .execution import ExecutionResult, ExecutionSpec, get_executor
from .operations import OperationContext


class ConnectionFailed(RuntimeError):
    def __init__(self, result: ExecutionResult | None = None) -> None:
        super().__init__("Managed SSH connection could not be established")
        self.result = result


@dataclass
class _Master:
    path: Path
    task: Any = field(repr=False)
    leases: set[str] = field(default_factory=set)
    ready: bool = False
    idle_until: float | None = None
    reuse: float = 300


class SharedConnections:
    def __init__(self, directory: Callable[[], Path]) -> None:
        self._directory = directory
        self._guard = threading.RLock()
        self._masters: dict[str, _Master] = {}
        self._timer: threading.Timer | None = None
        self._timer_deadline: float | None = None
        self._closed = False

    @staticmethod
    def _result(task: Any) -> ExecutionResult | None:
        try:
            return task.wait(0)
        except TimeoutError:
            return None

    def acquire(self, operation: OperationContext, identity: str, command: list[str], env: dict[str, str], reuse: int,
                hold_config: Callable[[], Callable[[], None]] | None = None) -> Path:
        operation.check()
        executor = get_executor()
        key = hashlib.sha256((executor.name + "\0" + identity).encode()).hexdigest()[:24]
        with self._guard:
            if self._closed:
                raise ConnectionFailed()
            master = self._masters.get(key)
            if master is not None and self._result(master.task) is not None:
                self._masters.pop(key); master = None
            if master is None:
                if len(self._masters) >= 64:
                    idle = [(key, value) for key, value in self._masters.items() if not value.leases]
                    if not idle:
                        from .operations import OperationBusy
                        raise OperationBusy()
                    stale_key, stale = min(idle, key=lambda pair: pair[1].idle_until or 0)
                    self._masters.pop(stale_key)
                    stale.task.cancel()
                # Private per-master path: another backend/CLI process must
                # never attach to a socket whose lifetime it does not own.
                path = self._directory() / f"mux-{key[:12]}-{uuid.uuid4().hex[:8]}"
                # ControlPersist must stay off: its fork would escape the root
                # handle. The manager implements an idle lifetime with leases.
                args = [*command[:-1], "-M", "-N", "-o", "ControlMaster=yes", "-o", "ControlPersist=no",
                        "-o", "ForkAfterAuthentication=no", "-o", f"ControlPath={path}",
                        "-o", "StrictHostKeyChecking=yes", "-o", "NumberOfPasswordPrompts=1", command[-1]]
                release_config = hold_config() if hold_config else lambda: None
                try:
                    task = executor.start(ExecutionSpec(tuple(args), env=env, timeout=86400,
                                                         stdout_limit=65536, stderr_limit=65536))
                except BaseException:
                    release_config()
                    raise
                master = _Master(path, task, reuse=reuse)
                self._masters[key] = master
                task.add_done_callback(lambda _task: self._remove_socket(path))
                task.add_done_callback(lambda _task: release_config())
            if operation.id not in master.leases:
                master.leases.add(operation.id)
                operation.when_finished(lambda: self._release(key, master, operation.id))
            master.idle_until = None
            self._reschedule()
        try:
            while True:
                operation.check()
                with self._guard:
                    if master.ready:
                        return master.path
                result = self._result(master.task)
                if result is not None:
                    raise ConnectionFailed(result)
                if master.path.exists():
                    # Local mux control only: no remote command, no second
                    # handshake and no credential inspection.
                    check = [*command[:-1], "-S", str(master.path), "-O", "check", command[-1]]
                    result = executor.start(ExecutionSpec(tuple(check), env=env,
                                                           timeout=operation.remaining(2), stdout_limit=65536,
                                                           stderr_limit=65536), operation).wait()
                    if result.reason == "exit" and result.returncode == 0:
                        with self._guard:
                            master.ready = True
                        return master.path
                operation.canceled.wait(min(0.025, operation.remaining()))
        except BaseException:
            self._release(key, master, operation.id)
            raise

    def _release(self, key: str, master: _Master, operation_id: str) -> None:
        with self._guard:
            master.leases.discard(operation_id)
            if master.leases or self._masters.get(key) is not master:
                return
            if not master.ready:
                self._masters.pop(key)
                master.task.cancel()
            else:
                master.idle_until = time.monotonic() + master.reuse
            self._reschedule()

    @staticmethod
    def _remove_socket(path: Path) -> None:
        try:
            if stat.S_ISSOCK(path.lstat().st_mode):
                path.unlink()
        except OSError:
            pass

    def _reschedule(self) -> None:
        deadlines = [item.idle_until for item in self._masters.values() if item.idle_until is not None]
        deadline = min(deadlines) if deadlines and not self._closed else None
        if self._timer is not None and deadline == self._timer_deadline:
            return
        if self._timer:
            self._timer.cancel(); self._timer = None
        self._timer_deadline = deadline
        if deadline is None:
            return
        self._timer = threading.Timer(max(0, deadline - time.monotonic()), self._expire)
        self._timer.daemon = True; self._timer.start()

    def _expire(self) -> None:
        with self._guard:
            self._timer = None
            self._timer_deadline = None
            now = time.monotonic()
            expired = [(key, item) for key, item in self._masters.items()
                       if not item.leases and item.idle_until is not None and item.idle_until <= now]
            for key, item in expired:
                self._masters.pop(key); item.task.cancel()
            self._reschedule()

    def close(self) -> None:
        with self._guard:
            self._closed = True
            if self._timer:
                self._timer.cancel(); self._timer = None
            masters, self._masters = list(self._masters.values()), {}
        for master in masters:
            master.task.cancel()
        deadline = time.monotonic() + 8
        for master in masters:
            try:
                master.task.wait(max(0, deadline - time.monotonic()))
            except TimeoutError:
                pass

"""Private immutable SSH snapshots with reference-counted request/master owners.

Only executor operations use this overlay. The user's managed/original config
is not changed: main SSH processes explicitly select their owned master, while
ProxyJump helpers inherit foreground, non-multiplexed operation semantics.
"""
from __future__ import annotations

import os
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .operations import OperationContext
from .paths import runtime_dir

_PREFIX = b"# Hoploom request-owned process policy\nHost *\n  ControlMaster no\n  ControlPersist no\n  ControlPath none\n  ForkAfterAuthentication no\n\n"


@dataclass
class _Snapshot:
    path: Path
    references: int = 1


class RequestConfigs:
    def __init__(self) -> None:
        self._guard = threading.RLock()
        self._operations: dict[str, _Snapshot] = {}
        self._paths: dict[Path, _Snapshot] = {}

    def acquire(self, operation: OperationContext, source: Path) -> Path:
        with self._guard:
            snapshot = self._operations.get(operation.id)
            if snapshot is not None:
                return snapshot.path
            descriptor, filename = tempfile.mkstemp(prefix="owned-", suffix=".conf", dir=runtime_dir())
            path = Path(filename)
            try:
                with os.fdopen(descriptor, "wb") as handle:
                    handle.write(_PREFIX)
                    handle.write(source.read_bytes())
                if os.name != "nt":
                    path.chmod(0o600)
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            snapshot = _Snapshot(path)
            self._operations[operation.id] = snapshot
            self._paths[path] = snapshot
            def release_operation() -> None:
                with self._guard:
                    self._operations.pop(operation.id, None)
                self._release(snapshot)
            operation.when_finished(release_operation)
            return path

    def hold(self, path: Path) -> Callable[[], None]:
        with self._guard:
            snapshot = self._paths[path]
            snapshot.references += 1
        released = False
        def release() -> None:
            nonlocal released
            with self._guard:
                if released:
                    return
                released = True
            self._release(snapshot)
        return release

    def _release(self, snapshot: _Snapshot) -> None:
        with self._guard:
            snapshot.references -= 1
            if snapshot.references:
                return
            self._paths.pop(snapshot.path, None)
            snapshot.path.unlink(missing_ok=True)

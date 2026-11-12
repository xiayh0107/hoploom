#!/usr/bin/env python3
"""Exercise an installed native wheel with local disposable child processes."""
import os
import sys

from ssh_server_manager import __version__, _native
from ssh_server_manager.execution import ExecutionSpec, executor_status, get_executor

assert _native.version == __version__ == sys.argv[1]
assert not _native.initialized(), "import/help must not start Tokio"
assert executor_status()["available"]
assert not _native.initialized(), "doctor evidence must not start Tokio"
for backend in ("rust", "python"):
    executor = get_executor(backend)
    task = executor.start(ExecutionSpec((sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'wheel\\x00ok')"), env=dict(os.environ)))
    result = task.wait(10)
    assert result.reason == "exit" and result.returncode == 0 and result.stdout == b"wheel\x00ok"
    task = executor.start(ExecutionSpec((sys.executable, "-c", "import time; time.sleep(60)"), timeout=.1))
    assert task.wait(10).reason == "timeout"
    task = executor.start(ExecutionSpec((sys.executable, "-c", "import time; time.sleep(60)")))
    task.wait_started(10)
    task.cancel()
    assert task.wait(10).reason == "canceled"
assert _native.initialized()
_native.shutdown()
print("Installed Rust/Python execution, timeout and cancellation passed")

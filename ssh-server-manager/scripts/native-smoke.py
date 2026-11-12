#!/usr/bin/env python3
"""Exercise an installed native wheel with local disposable child processes."""
import os
import sys
import io
import json
from pathlib import Path
from contextlib import redirect_stdout
from tempfile import TemporaryDirectory

from ssh_server_manager import __version__, _native
from ssh_server_manager.execution import ExecutionSpec, executor_status, get_executor

assert _native.version == __version__ == sys.argv[1]
assert not _native.initialized(), "import/help must not start Tokio"
assert executor_status()["available"]
assert not _native.initialized(), "doctor evidence must not start Tokio"
from ssh_server_manager.cli import main
with TemporaryDirectory(prefix="hoploom-native-metadata-") as temporary:
    root = Path(temporary)
    os.environ.update(SSM_DATA_DIR=str(root / "data"), SSM_RUNTIME_DIR=str(root / "runtime"),
                      SSM_ORIGINAL_SSH_CONFIG=str(root / "original.conf"), SSM_MANAGED_SSH_CONFIG=str(root / "managed.conf"))
    for arguments in (["--help"], ["--version"], ["server", "list", "--json"]):
        output = io.StringIO()
        with redirect_stdout(output):
            try:
                assert main(arguments) == 0
            except SystemExit as exit:
                assert exit.code == 0
        if arguments[0] == "server":
            assert json.loads(output.getvalue()) == []
        assert not _native.initialized(), "help/version/local metadata must not start Tokio"
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

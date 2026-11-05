"""Stoppable transfer processes and the byte counts their progress comes from."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import pytest

from ssh_server_manager.transfer_control import Cancelled, DeadlineExceeded, read_position, run_stoppable


def python(code: str, *args: str) -> list[str]:
    return [sys.executable, "-I", "-c", code, *args]


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for(predicate, timeout: float = 5) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        time.sleep(0.02)


def test_a_finished_run_returns_its_status_and_bounded_output():
    code = "import sys; data = sys.stdin.read(); print(data.upper()); print('warn', file=sys.stderr); sys.stdout.write('x' * 600000); sys.exit(3)"
    returncode, stdout, stderr = run_stoppable(python(code), input_text="get file\n", env=dict(os.environ), timeout=10)
    assert returncode == 3
    assert stdout.startswith("GET FILE\n")
    # The cap counts captured bytes; newline normalisation can shorten the
    # decoded text, so assert the bound rather than an exact count.
    assert 255 * 1024 < len(stdout) <= 256 * 1024
    assert stderr.strip() == "warn"


def test_cancel_and_deadline_stop_the_process_promptly():
    cancel = threading.Event()
    started = []
    outcome = []

    def run():
        try:
            run_stoppable(python("import time; time.sleep(60)"), input_text="", env=dict(os.environ), timeout=60,
                          cancel=cancel, on_start=started.append)
        except Cancelled:
            outcome.append("cancelled")

    worker = threading.Thread(target=run)
    worker.start()
    wait_for(lambda: started)
    began = time.monotonic()
    cancel.set()
    worker.join(timeout=5)
    assert outcome == ["cancelled"]
    assert time.monotonic() - began < 3
    assert started[0].returncode is not None

    with pytest.raises(DeadlineExceeded):
        run_stoppable(python("import time; time.sleep(60)"), input_text="", env=dict(os.environ), timeout=0.3)


def test_a_failing_start_hook_still_stops_the_process():
    seen = []

    def hook(process):
        seen.append(process)
        raise RuntimeError("meter failed")

    with pytest.raises(RuntimeError):
        run_stoppable(python("import time; time.sleep(60)"), input_text="", env=dict(os.environ), timeout=60, on_start=hook)
    assert seen[0].returncode is not None


@pytest.mark.skipif(os.name == "nt", reason="POSIX signal semantics")
def test_cancel_signals_only_sftp_and_spares_a_shared_masters_helper(tmp_path):
    # Like sftp, the child stops its own ssh on SIGTERM. Like a ControlMaster's
    # ProxyJump helper, the bystander stays in the group after its parent moved
    # on; killing the group would cut a connection other requests still use.
    pids = tmp_path / "pids"
    code = (
        "import os, signal, subprocess, sys, time\n"
        "sleep = [sys.executable, '-c', 'import time; time.sleep(60)']\n"
        "own, bystander = subprocess.Popen(sleep), subprocess.Popen(sleep)\n"
        "def stop(*_):\n"
        "    own.terminate(); own.wait(); os._exit(1)\n"
        "signal.signal(signal.SIGTERM, stop)\n"
        "open(sys.argv[1], 'w').write(f'{own.pid} {bystander.pid}')\n"
        "time.sleep(60)\n"
    )
    cancel = threading.Event()
    worker = threading.Thread(target=lambda: pytest.raises(Cancelled, run_stoppable, python(code, str(pids)),
                                                           input_text="", env=dict(os.environ), timeout=60, cancel=cancel))
    worker.start()
    wait_for(lambda: pids.exists() and pids.read_text().strip())
    own, bystander = map(int, pids.read_text().split())
    try:
        cancel.set()
        worker.join(timeout=5)
        assert not worker.is_alive()
        wait_for(lambda: not alive(own))
        assert alive(bystander)
    finally:
        try:
            os.kill(bystander, 9)
        except ProcessLookupError:
            pass


def test_read_position_follows_another_process_through_a_file(tmp_path):
    source = tmp_path / "upload"
    source.write_bytes(os.urandom(300_000))
    code = (
        "import os, sys, time\n"
        "handle = os.open(sys.argv[1], os.O_RDONLY)\n"
        "os.read(handle, 123_456)\n"
        "print('ready', flush=True)\n"
        "time.sleep(30)\n"
    )
    child = subprocess.Popen(python(code, str(source)), stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "ready"
        position = read_position(child.pid, source)
        if sys.platform == "darwin" or sys.platform.startswith("linux"):
            assert position == 123_456
            assert read_position(child.pid, tmp_path / "other") is None
        else:
            assert position is None
    finally:
        child.kill()
        child.wait()
    assert read_position(child.pid, source) is None

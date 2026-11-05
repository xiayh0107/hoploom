"""Real OpenSSH sftp against the loopback fixture: a cancelled browser transfer
stops at once, leaves the destination as it was, counts real bytes, and never
takes down a shared ControlMaster that other requests are using."""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

paramiko = pytest.importorskip("paramiko")
if not shutil.which("ssh") or not shutil.which("sftp"):
    pytest.skip("OpenSSH client required for loopback integration", allow_module_level=True)

from ssh_server_manager.paths import runtime_dir
from ssh_server_manager.ssh_runner import FileOperationError, SSHRunner

spec = importlib.util.spec_from_file_location("ssm_cancel_fixture", Path(__file__).parent / "manual" / "modern_fixture.py")
modern_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(modern_fixture)

SIZE = 24 * 1024 * 1024


@pytest.fixture(scope="module")
def loopback():
    with modern_fixture.fixture_environment() as fixture:
        yield fixture


@pytest.fixture
def slow_server(monkeypatch):
    """Make the fixture's SFTP server take a few seconds per transfer."""
    write, read = paramiko.SFTPHandle.write, paramiko.SFTPHandle.read

    def slow_write(self, offset, data):
        time.sleep(0.004)
        return write(self, offset, data)

    def slow_read(self, offset, length):
        time.sleep(0.004)
        return read(self, offset, length)

    monkeypatch.setattr(modern_fixture.FixtureHandle, "write", slow_write, raising=False)
    monkeypatch.setattr(modern_fixture.FixtureHandle, "read", slow_read, raising=False)


def cancel_midway(work, *, threshold=1024 * 1024, progress=None):
    """Run work(cancel, meter) in a thread; cancel once enough bytes moved.

    sftp's read position is only visible on Linux and macOS. A caller that can
    measure progress from the other side, such as the bytes a loopback server
    has written, passes `progress` so Windows still cancels mid-transfer.
    """
    cancel, readings, outcome, meters = threading.Event(), [], {}, []

    def run():
        try:
            outcome["result"] = work(cancel, lambda total, count: meters.append((total, count)))
        except FileOperationError as exc:
            outcome["error"] = exc

    worker = threading.Thread(target=run)
    worker.start()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if meters:
            value = meters[0][1]()
            if value is not None:
                readings.append(value)
                if value >= threshold:
                    break
            elif progress is not None and progress() >= threshold:
                break
        time.sleep(0.02)
    cancelled_at = time.monotonic()
    cancel.set()
    worker.join(15)
    assert not worker.is_alive()
    return outcome, readings, meters, time.monotonic() - cancelled_at


def payload(tmp_path):
    source = tmp_path / "large.bin"
    source.write_bytes(os.urandom(SIZE))
    return source


def counted():
    import sys
    return sys.platform == "darwin" or sys.platform.startswith("linux")


@pytest.mark.parametrize("overwrite", [True, False])
def test_a_cancelled_upload_stops_and_leaves_the_destination_unchanged(loopback, tmp_path, slow_server, overwrite):
    runner = SSHRunner(loopback["database"])
    remote = loopback["remote"]
    name = f"cancel-{'replace' if overwrite else 'new'}.txt"
    if overwrite:
        (remote / name).write_text("keep me\n")
    source = payload(tmp_path)

    def staged_bytes():
        # The server writes the upload into a .ssm-upload-* file beside the
        # target before publishing it, so its size is real progress on every OS.
        total = 0
        for path in remote.glob(".ssm-upload-*"):
            try:
                total += path.stat().st_size
            except FileNotFoundError:
                continue  # Published or cleaned up between the glob and the stat.
        return total

    outcome, readings, meters, latency = cancel_midway(
        lambda cancel, meter: runner.upload(
            "direct", source, f"/{name}", timeout=60, reuse=0, overwrite=overwrite, cancel=cancel, meter=meter),
        progress=staged_bytes)

    assert outcome["error"].error_code == "canceled", outcome
    assert latency < 5
    assert meters and meters[0][0] == SIZE
    if counted():
        assert readings and 0 < readings[-1] < SIZE
        assert readings == sorted(readings)
    if overwrite:
        assert (remote / name).read_text() == "keep me\n"
    else:
        assert not (remote / name).exists()
    assert not list(remote.glob(".ssm-upload-*"))


def test_a_cancelled_download_stops_with_a_partial_count(loopback, tmp_path, slow_server):
    runner = SSHRunner(loopback["database"])
    (loopback["remote"] / "cancel-download.bin").write_bytes(os.urandom(SIZE))
    destination = tmp_path / "download"

    outcome, readings, meters, latency = cancel_midway(lambda cancel, meter: runner.download(
        "direct", "/cancel-download.bin", destination, timeout=60, reuse=0, max_bytes=SIZE, cancel=cancel, meter=meter))

    assert outcome["error"].error_code == "canceled", outcome
    assert latency < 5
    assert meters[0][0] == SIZE
    assert readings and 0 < readings[-1] < SIZE


def test_an_uncancelled_overwrite_publishes_the_whole_file(loopback, tmp_path):
    runner = SSHRunner(loopback["database"])
    (loopback["remote"] / "replace-me.bin").write_text("old\n")
    source = tmp_path / "new.bin"
    source.write_bytes(os.urandom(512 * 1024))
    totals = []
    runner.upload("direct", source, "/replace-me.bin", timeout=30, reuse=0, overwrite=True,
                  cancel=threading.Event(), meter=lambda total, count: totals.append(total))
    assert (loopback["remote"] / "replace-me.bin").read_bytes() == source.read_bytes()
    assert totals == [source.stat().st_size]
    assert not list(loopback["remote"].glob(".ssm-upload-*"))


def masters():
    """Running ControlMaster pids by control socket, as OpenSSH reports them."""
    running = {}
    for socket in Path(runtime_dir()).glob("cm-*"):
        result = subprocess.run(["ssh", "-F", "none", "-o", f"ControlPath={socket}", "-O", "check", "fixture"],
                                capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and "pid=" in result.stderr:
            running[socket] = result.stderr.split("pid=")[1].split(")")[0]
    return running


@pytest.mark.skipif(os.name == "nt", reason="Hoploom uses no ControlMaster on Windows")
def test_cancelling_a_transfer_keeps_the_shared_master_and_its_proxy_alive(loopback, tmp_path, slow_server):
    runner = SSHRunner(loopback["database"])
    before = masters()
    source = payload(tmp_path)
    # The cancelled sftp is the one that starts the shared master, over a
    # two-hop ProxyJump route, so the master's proxy helper shares its group.
    outcome, _readings, _meters, latency = cancel_midway(lambda cancel, meter: runner.upload(
        "multi-hop", source, "/shared-master.bin", timeout=60, reuse=300, overwrite=False, cancel=cancel, meter=meter))
    assert outcome["error"].error_code == "canceled", outcome
    assert latency < 5
    started = {socket: pid for socket, pid in masters().items() if socket not in before}
    try:
        assert len(started) == 1, started
        # The next request reuses the very same master through the same proxy.
        small = tmp_path / "after.txt"
        small.write_text("after cancel\n")
        runner.upload("multi-hop", small, "/after-cancel.txt", timeout=30, reuse=300, overwrite=False)
        assert (loopback["remote"] / "after-cancel.txt").read_text() == "after cancel\n"
        assert {socket: pid for socket, pid in masters().items() if socket not in before} == started
    finally:
        for socket in started:
            subprocess.run(["ssh", "-F", "none", "-o", f"ControlPath={socket}", "-O", "exit", "fixture"],
                           capture_output=True, timeout=10)

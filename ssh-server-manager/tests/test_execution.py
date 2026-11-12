from __future__ import annotations

import asyncio
import os
import sys
import threading

import pytest

from ssh_server_manager.execution import ExecutionSpec, capture_command, get_executor
from ssh_server_manager.operations import OperationContext
from ssh_server_manager.operations import ExecutionUnavailable


@pytest.fixture(params=["python", "rust"])
def executor(request):
    return get_executor(request.param)


def command(code: str, **options):
    return ExecutionSpec((sys.executable, "-c", code), **options)


def test_executor_captures_binary_pipes_and_exit_without_exposing_input_in_repr(executor):
    spec = command("import sys;data=sys.stdin.buffer.read();sys.stdout.buffer.write(data);sys.stderr.write('err');sys.exit(7)", input=b"private-fixture")
    result = executor.start(spec).wait(5)
    assert (result.reason, result.returncode, result.stdout, result.stderr) == ("exit", 7, b"private-fixture", b"err")
    assert "private-fixture" not in repr(spec) + repr(result)


@pytest.mark.parametrize("pipe", ["stdout", "stderr"])
def test_hostile_output_is_bounded_and_cannot_be_reported_as_success(pipe, executor):
    task = executor.start(command(f"import sys;sys.{pipe}.buffer.write(b'x'*1000000);sys.{pipe}.flush()", stdout_limit=128, stderr_limit=128))
    result = task.wait(5)
    assert result.reason == "output_limit"
    assert len(result.stdout) <= 128 and len(result.stderr) <= 128


def test_timeout_applies_when_child_never_reads_input(executor):
    result = executor.start(command("import time;time.sleep(60)", input=b"x" * (1024 * 1024), timeout=0.05)).wait(5)
    assert result.reason == "timeout"


def test_cancel_notifies_completion_and_preserves_an_unrelated_operation(executor):
    executor = executor
    canceled = executor.start(command("import time;time.sleep(60)"))
    unrelated = executor.start(command("print('unrelated')"))
    done = threading.Event()
    canceled.add_done_callback(lambda _task: done.set())
    assert canceled.wait_started(3) is not None
    canceled.cancel()
    assert canceled.wait(5).reason == "canceled"
    assert done.wait(1)
    assert unrelated.wait(5).stdout == b"unrelated" + os.linesep.encode("ascii")


def test_operation_cancellation_propagates_to_its_task(executor):
    operation = OperationContext("host", 3)
    task = executor.start(command("import time;time.sleep(60)"), operation)
    task.wait_started(3); operation.cancel()
    assert task.wait(5).reason == "canceled"


def test_async_completion_uses_notification_and_async_cancel_stops_the_process(executor):
    async def run():
        task = executor.start(command("print('async')"))
        assert (await task.result_async()).stdout == b"async" + os.linesep.encode("ascii")
        stopped = executor.start(command("import time;time.sleep(60)"))
        future = asyncio.create_task(stopped.result_async())
        await asyncio.sleep(0)
        future.cancel()
        with pytest.raises(asyncio.CancelledError):
            await future
        assert stopped.wait(5).reason == "canceled"
    asyncio.run(run())


def test_missing_program_is_structured_and_never_retried(executor):
    result = executor.start(ExecutionSpec(("hoploom-deliberately-missing-program",))).wait(5)
    assert result.reason == "spawn_failed" and result.returncode is None


def test_capture_adapter_accepts_no_stdin_and_keeps_binary_output_exact(executor, monkeypatch):
    monkeypatch.setenv("HOPLOOM_EXECUTOR", executor.name)
    no_input = capture_command([sys.executable, "-c", "print('no input')"], env=dict(os.environ), input_text=None, timeout=3)
    assert no_input.stdout == "no input\n"
    binary = capture_command([sys.executable, "-c", "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                             env=dict(os.environ), input_text=b"\xff\x00\r\n", timeout=3, text=False)
    assert binary.stdout == b"\xff\x00\r\n"


@pytest.mark.skipif(os.name == "nt", reason="Unix-only process group assertion; Windows Job coverage runs in CI")
def test_descendant_holding_output_open_is_stopped_even_when_parent_exits(executor):
    code = "import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);print('parent')"
    result = executor.start(command(code)).wait(5)
    assert result.reason == "exit" and result.stdout == b"parent\n"


def test_missing_or_incompatible_native_module_never_starts_python_rollback(monkeypatch):
    from types import SimpleNamespace
    from ssh_server_manager import execution
    monkeypatch.setattr(execution, "_native_module", None)
    monkeypatch.setenv("HOPLOOM_EXECUTOR", "rust")
    monkeypatch.setattr(execution.importlib, "import_module", lambda name: SimpleNamespace(version="0.0.0"))
    monkeypatch.setattr(execution.PythonExecutor, "start", lambda *args: pytest.fail("must not replay on Python"))
    with pytest.raises(ExecutionUnavailable):
        execution.get_executor()
    status = execution.executor_status()
    assert status["available"] is False and status["initialized"] is False
    monkeypatch.setenv("HOPLOOM_EXECUTOR", "python")
    assert execution.executor_status() == {"selected": "python", "initialized": False, "ok": True, "available": True}


def test_python_deadline_includes_pending_supervision_before_process_start(monkeypatch):
    from types import SimpleNamespace
    from ssh_server_manager import execution
    entered, ready = threading.Event(), threading.Event()
    clock = [100.0]
    original = execution.PythonTaskHandle._run
    def delayed(self, *args):
        entered.set()
        assert ready.wait(2)
        return original(self, *args)
    monkeypatch.setattr(execution, 'time', SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(execution.PythonTaskHandle, '_run', delayed)
    monkeypatch.setattr(execution, 'ProcessOwner', lambda *args, **kw: pytest.fail('expired work must never spawn'))
    task = execution.PythonExecutor().start(command("print('expired')", timeout=.1))
    try:
        assert entered.wait(1)
        clock[0] = 101.0
    finally:
        ready.set()
    result = task.wait(2)
    assert result.reason == 'timeout' and result.pid is None and result.elapsed_ms == 1000


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object descendant verification")
def test_job_cancellation_waits_for_a_real_descendant_to_exit(executor, tmp_path):
    import ctypes
    from ctypes import wintypes
    import time
    marker = tmp_path / "descendant.pid"
    child = f"import os,time,pathlib;pathlib.Path({str(marker)!r}).write_text(str(os.getpid()));time.sleep(60)"
    parent = f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child!r}]);time.sleep(60)"
    task = executor.start(command(parent))
    try:
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        pid = int(marker.read_text())
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        assert handle
        try:
            assert kernel.WaitForSingleObject(handle, 0) == 258
            task.cancel()
            assert task.wait(8).reason == "canceled"
            assert kernel.WaitForSingleObject(handle, 0) == 0
        finally:
            kernel.CloseHandle(handle)
    finally:
        task.cancel()
        task.wait(8)

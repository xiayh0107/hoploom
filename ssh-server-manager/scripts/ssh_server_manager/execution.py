"""Executor contract shared by the native core and the explicit Python rollback.

Commands, environment and input are intentionally excluded from repr. Policy,
OpenSSH argument construction, credentials and output redaction stay with the
Python caller; an executor owns only its request's process and bounded pipes.
"""
from __future__ import annotations

import asyncio
import atexit
import importlib
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Literal

from .operations import CancellationToken, ExecutionUnavailable, OperationCancelled, OperationContext, OperationError, OperationTimeout, current_operation
from .process_args import literal_config_args
from .process_owner import ProcessOwner

Reason = Literal["exit", "canceled", "timeout", "output_limit", "spawn_failed", "cleanup_failed"]


@dataclass(frozen=True)
class ExecutionSpec:
    command: tuple[str, ...] = field(repr=False)
    env: dict[str, str] = field(default_factory=lambda: dict(os.environ), repr=False)
    input: bytes = field(default=b"", repr=False)
    timeout: float = 30
    stdout_limit: int = 8 * 1024 * 1024
    stderr_limit: int = 64 * 1024
    owned_tree: bool = True

    def __post_init__(self) -> None:
        if not self.command or not self.command[0] or any(not isinstance(arg, str) or "\0" in arg for arg in self.command):
            raise ValueError("Invalid execution command")
        if not 0 < self.timeout <= 86400:
            raise ValueError("Invalid execution timeout")
        if any(not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 16 * 1024 * 1024
               for value in (self.stdout_limit, self.stderr_limit)):
            raise ValueError("Invalid execution output limit")
        if not isinstance(self.input, bytes) or len(self.input) > 2 * 1024 * 1024:
            raise ValueError("Execution input exceeds 2 MiB")
        if any(not isinstance(key, str) or not isinstance(value, str) or not key or "=" in key or "\0" in key or "\0" in value
               for key, value in self.env.items()):
            raise ValueError("Invalid execution environment")


@dataclass(frozen=True)
class ExecutionResult:
    reason: Reason
    returncode: int | None
    stdout: bytes = field(repr=False)
    stderr: bytes = field(repr=False)
    elapsed_ms: int
    pid: int | None = None


class PythonTaskHandle:
    def __init__(self, spec: ExecutionSpec, operation: OperationContext | None = None) -> None:
        self._cancel = CancellationToken()
        self._done, self._started = threading.Event(), threading.Event()
        self._guard = threading.Lock()
        self._result: ExecutionResult | None = None
        self._callbacks: list[Callable[[PythonTaskHandle], None]] = []
        self.pid: int | None = None
        # Evaluate the parent's deadline before starting a thread.
        timeout = operation.remaining(spec.timeout) if operation else spec.timeout
        release = operation.canceled.subscribe(self.cancel) if operation else lambda: None
        def work() -> None:
            try:
                result = self._run(spec, timeout)
            except Exception:
                result = ExecutionResult("spawn_failed", None, b"", b"", 0, self.pid)
            finally:
                release()
                self._started.set()
            with self._guard:
                self._result = result
                callbacks, self._callbacks = self._callbacks, []
                self._done.set()
            for callback in callbacks:
                try:
                    callback(self)
                except Exception:
                    pass
        self._worker = threading.Thread(target=work, name="hoploom-python-executor", daemon=True)
        self._worker.start()

    def cancel(self) -> None:
        self._cancel.set()

    def wait(self, timeout: float | None = None) -> ExecutionResult:
        if not self._done.wait(timeout):
            raise TimeoutError("The execution result is not ready")
        assert self._result is not None
        return self._result

    def wait_started(self, timeout: float | None = None) -> int | None:
        if not self._started.wait(timeout):
            raise TimeoutError("The execution has not started")
        return self.pid

    def add_done_callback(self, callback: Callable[[PythonTaskHandle], None]) -> None:
        with self._guard:
            ready = self._done.is_set()
            if not ready:
                self._callbacks.append(callback)
        if ready:
            callback(self)

    async def result_async(self) -> ExecutionResult:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[ExecutionResult] = loop.create_future()
        def complete(_task: PythonTaskHandle) -> None:
            def deliver() -> None:
                if not future.done():
                    future.set_result(self.wait(0))
            try:
                loop.call_soon_threadsafe(deliver)
            except RuntimeError:
                self.cancel()
        self.add_done_callback(complete)
        try:
            return await future
        except asyncio.CancelledError:
            self.cancel()
            raise

    def _run(self, spec: ExecutionSpec, timeout: float) -> ExecutionResult:
        start = time.monotonic()
        if self._cancel.is_set():
            return ExecutionResult("canceled", None, b"", b"", 0)
        try:
            owner = ProcessOwner(literal_config_args(list(spec.command)), env=spec.env, tree=spec.owned_tree)
        except OSError:
            return ExecutionResult("spawn_failed", None, b"", b"", round((time.monotonic() - start) * 1000))
        process = owner.process
        self.pid = process.pid
        self._started.set()
        output, errors = bytearray(), bytearray()
        exceeded, io_error = threading.Event(), threading.Event()
        def read(pipe, destination: bytearray, limit: int) -> None:
            try:
                with pipe:
                    read_chunk = getattr(pipe, "read1", pipe.read)
                    while chunk := read_chunk(65536):
                        room = limit - len(destination)
                        destination.extend(chunk[:room])
                        if len(chunk) > room:
                            exceeded.set()
            except (OSError, ValueError):
                io_error.set()
        def write() -> None:
            try:
                with process.stdin:
                    process.stdin.write(spec.input)
            except (OSError, ValueError):
                pass  # A program may exit without consuming its input.
        readers = [threading.Thread(target=read, args=(process.stdout, output, spec.stdout_limit), daemon=True),
                   threading.Thread(target=read, args=(process.stderr, errors, spec.stderr_limit), daemon=True),
                   threading.Thread(target=write, daemon=True)]
        for reader in readers:
            reader.start()
        reason: Reason = "exit"
        try:
            while True:
                if self._cancel.is_set():
                    reason = "canceled"; break
                if time.monotonic() - start >= timeout:
                    reason = "timeout"; break
                if exceeded.is_set():
                    reason = "output_limit"; break
                if process.poll() is not None:
                    break
                self._cancel.wait(0.01)
        finally:
            try:
                owner.close()
            except (OSError, TimeoutError):
                reason = "cleanup_failed"
            cleanup_deadline = time.monotonic() + 3
            for reader in readers:
                reader.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            if any(reader.is_alive() for reader in readers):
                reason = "cleanup_failed"
        if reason == "exit":
            if exceeded.is_set():
                reason = "output_limit"
            elif io_error.is_set():
                reason = "spawn_failed"
        return ExecutionResult(reason, process.returncode if reason == "exit" else None, bytes(output), bytes(errors),
                               round((time.monotonic() - start) * 1000), self.pid)


class PythonExecutor:
    name = "python"

    def start(self, spec: ExecutionSpec, operation: OperationContext | None = None) -> PythonTaskHandle:
        return PythonTaskHandle(spec, operation)


class NativeTaskHandle:
    def __init__(self, native, spec: ExecutionSpec, operation: OperationContext | None = None) -> None:
        timeout = operation.remaining(spec.timeout) if operation else spec.timeout
        prepared = literal_config_args(list(spec.command))
        raw_args = None
        if isinstance(prepared, str):
            # Preserve the established native-Windows/MSYS -F quoting adapter.
            executable = subprocess.list2cmdline([spec.command[0]])
            if not prepared.startswith(executable + " "):
                raise ValueError("Invalid literal argument serialization")
            raw_args = prepared[len(executable) + 1:]
        try:
            self._handle = native.start(spec.command[0], list(spec.command[1:]), spec.env, spec.input,
                                        timeout, spec.stdout_limit, spec.stderr_limit, spec.owned_tree, raw_args)
        except RuntimeError:
            raise ExecutionUnavailable() from None
        if operation:
            release = operation.canceled.subscribe(self.cancel)
            self._handle.add_done_callback(release)

    @property
    def pid(self) -> int | None:
        return self._handle.pid

    def cancel(self) -> None:
        self._handle.cancel()

    def wait(self, timeout: float | None = None) -> ExecutionResult:
        reason, code, output, errors, elapsed, pid = self._handle.wait(timeout)
        return ExecutionResult(reason, code, output, errors, elapsed, pid)

    def wait_started(self, timeout: float | None = None) -> int | None:
        return self._handle.wait_started(timeout)

    def add_done_callback(self, callback: Callable) -> None:
        self._handle.add_done_callback(lambda: callback(self))

    # Completion is driven by a native callback, not an asyncio polling task
    # or a Python thread waiting for each Rust process.
    result_async = PythonTaskHandle.result_async


_native_module = None


class NativeExecutor:
    name = "rust"

    def __init__(self) -> None:
        global _native_module
        if _native_module is None:
            from . import __version__
            try:
                native = importlib.import_module("ssh_server_manager._native")
            except (ImportError, OSError):
                raise ExecutionUnavailable() from None
            if (getattr(native, "version", None) != __version__
                    or not all(callable(getattr(native, name, None)) for name in ("start", "shutdown", "initialized"))
                    or getattr(native, "worker_threads", None) != 2):
                raise ExecutionUnavailable()
            _native_module = native
            atexit.register(native.shutdown)
        self._native = _native_module

    def start(self, spec: ExecutionSpec, operation: OperationContext | None = None) -> NativeTaskHandle:
        return NativeTaskHandle(self._native, spec, operation)


def get_executor(name: str | None = None) -> NativeExecutor | PythonExecutor:
    selected = name if name is not None else os.environ.get("HOPLOOM_EXECUTOR", "rust")
    if selected == "python":
        return PythonExecutor()
    if selected == "rust":
        return NativeExecutor()
    raise ValueError("HOPLOOM_EXECUTOR must be rust or python")


def executor_status() -> dict:
    """Local import/ABI evidence only; never initialize the native runtime."""
    selected = os.environ.get("HOPLOOM_EXECUTOR", "rust")
    status = {"selected": selected, "initialized": False}
    try:
        executor = get_executor(selected)
    except (ExecutionUnavailable, ValueError) as exc:
        return {**status, "ok": False, "available": False, "message": str(exc),
                "recovery": "Reinstall the matching native wheel or explicitly select HOPLOOM_EXECUTOR=python"}
    return {**status, "ok": True, "available": True,
            "initialized": executor._native.initialized() if selected == "rust" else False,
            **({"native_version": executor._native.version, "worker_threads": executor._native.worker_threads} if selected == "rust" else {})}


def capture_command(command: list[str], *, env: dict[str, str], input_text: str | bytes | None = "", timeout: float,
                    stdout_limit: int = 8 * 1024 * 1024, stderr_limit: int = 65536,
                    cancel: threading.Event | None = None, on_start: Callable | None = None,
                    text: bool = True) -> subprocess.CompletedProcess:
    operation = current_operation()
    data = input_text if isinstance(input_text, bytes) else (input_text or "").encode("utf-8")
    task = get_executor().start(ExecutionSpec(tuple(command), env=env, input=data,
                                             timeout=timeout, stdout_limit=stdout_limit,
                                             stderr_limit=stderr_limit), operation)
    release = cancel.subscribe(task.cancel) if isinstance(cancel, CancellationToken) else lambda: None
    try:
        if on_start and task.wait_started(operation.remaining() if operation else timeout) is not None:
            on_start(task)
        while True:
            if cancel is not None and cancel.is_set():
                task.cancel()
            try:
                result = task.wait(0.05 if cancel is not None and not isinstance(cancel, CancellationToken) else None)
                break
            except TimeoutError:
                continue
    except BaseException:
        task.cancel()
        try:
            task.wait(8)
        except TimeoutError:
            pass
        raise
    finally:
        release()
    if result.reason == "canceled":
        raise OperationCancelled()
    if result.reason == "timeout":
        if operation:
            operation.check()
        raise subprocess.TimeoutExpired(command, timeout)
    if result.reason == "output_limit":
        raise OperationError("Remote output exceeded the configured limit", "output_limit")
    if result.reason == "cleanup_failed":
        raise OperationError("The request process could not be fully stopped", "cleanup_failed")
    if result.reason == "spawn_failed":
        raise OSError("The request process could not be started")
    if not text:
        return subprocess.CompletedProcess(command, result.returncode, result.stdout, result.stderr)
    decode = lambda data: data.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    return subprocess.CompletedProcess(command, result.returncode, decode(result.stdout), decode(result.stderr))

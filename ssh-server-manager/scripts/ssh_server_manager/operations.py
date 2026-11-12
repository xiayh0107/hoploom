"""Bounded, cancellable user operations, independent of transport and executor.

One permit covers an operation's probes and fallback calls. Nested helpers
inherit it through contextvars (including asyncio.to_thread), so they cannot
deadlock by trying to acquire their parent's slot. No credentials live here.
"""
from __future__ import annotations

import contextvars
import asyncio
import threading
import time
import uuid
from collections import Counter, deque
from contextlib import asynccontextmanager, contextmanager, suppress
from dataclasses import dataclass, field
from typing import Callable, Iterator


class OperationError(RuntimeError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class OperationCancelled(OperationError):
    def __init__(self) -> None:
        super().__init__("Operation canceled", "canceled")


class OperationTimeout(OperationError):
    def __init__(self) -> None:
        super().__init__("Operation deadline exceeded", "timeout")


class OperationBusy(OperationError):
    def __init__(self) -> None:
        super().__init__("Operation queue is full; retry shortly", "busy")


class ExecutionUnavailable(OperationError):
    def __init__(self) -> None:
        super().__init__("The selected executor is unavailable; run hoploom doctor", "executor_unavailable")


class CancellationToken(threading.Event):
    """Event-compatible cancellation with immediate native-task notification."""

    def __init__(self) -> None:
        super().__init__()
        self._callbacks_guard = threading.Lock()
        self._callbacks: set[Callable[[], None]] = set()

    def set(self) -> None:
        super().set()
        with self._callbacks_guard:
            callbacks = tuple(self._callbacks)
            self._callbacks.clear()
        for callback in callbacks:
            try:
                callback()
            except Exception:
                # One failed observer must not leave the other tasks running.
                pass

    def subscribe(self, callback: Callable[[], None]) -> Callable[[], None]:
        with self._callbacks_guard:
            canceled = self.is_set()
            if not canceled:
                self._callbacks.add(callback)
        if canceled:
            callback()

        def release() -> None:
            with self._callbacks_guard:
                self._callbacks.discard(callback)
        return release


@dataclass(eq=False)
class OperationContext:
    host_id: str
    timeout: float
    session_id: str | None = field(default=None, repr=False)
    transfer: bool = False
    bulk: bool = False
    batch_id: str | None = field(default=None, repr=False)
    batch_limit: int = 4
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    canceled: CancellationToken = field(default_factory=CancellationToken, repr=False)
    deadline: float = field(init=False, repr=False)
    _finished: CancellationToken = field(default_factory=CancellationToken, init=False, repr=False)

    def __post_init__(self) -> None:
        if not 0 < self.timeout <= 86400:
            raise ValueError("Operation timeout must be between 0 and 86400 seconds")
        if not 1 <= self.batch_limit <= 4:
            raise ValueError("Batch concurrency must be between 1 and 4")
        self.deadline = time.monotonic() + self.timeout

    def cancel(self) -> None:
        self.canceled.set()

    def when_finished(self, callback: Callable[[], None]) -> Callable[[], None]:
        return self._finished.subscribe(callback)

    def finish(self) -> None:
        self._finished.set()

    def check(self) -> None:
        if self.canceled.is_set():
            raise OperationCancelled()
        if time.monotonic() >= self.deadline:
            raise OperationTimeout()

    def remaining(self, limit: float | None = None) -> float:
        self.check()
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise OperationTimeout()
        return remaining if limit is None else min(remaining, limit)


_current: contextvars.ContextVar[OperationContext | None] = contextvars.ContextVar("hoploom_operation", default=None)


def current_operation() -> OperationContext | None:
    return _current.get()


@contextmanager
def bind_operation(operation: OperationContext) -> Iterator[OperationContext]:
    """Run shared substeps with their own cancellation, without taking a new slot."""
    token = _current.set(operation)
    try:
        yield operation
    finally:
        _current.reset(token)


class OperationScheduler:
    """Eight operations, two per host, two transfers and 64 queued callers.

    Earlier eligible callers have priority; a busy host does not hold up
    unrelated hosts. Cancellation and total deadlines include queue waiting.
    """

    def __init__(self, *, active: int = 8, per_host: int = 2, transfers: int = 2, queued: int = 64, bulk_checks: int = 4) -> None:
        if min(active, per_host, transfers, bulk_checks) < 1 or queued < 0:
            raise ValueError("Invalid operation limits")
        self.active_limit, self.host_limit, self.transfer_limit, self.queue_limit = active, per_host, transfers, queued
        self._condition = threading.Condition()
        self._active: set[OperationContext] = set()
        self._hosts: Counter[str] = Counter()
        self._transfers = 0
        self._bulk = 0
        self._batches: Counter[str] = Counter()
        self.bulk_limit = bulk_checks
        self._queue: deque[OperationContext] = deque()
        self._closed = False
        self._async_waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()

    def _notify(self) -> None:
        self._condition.notify_all()
        for loop, event in self._async_waiters:
            try:
                loop.call_soon_threadsafe(event.set)
            except RuntimeError:
                pass

    def _eligible(self, operation: OperationContext) -> bool:
        return (len(self._active) < self.active_limit and self._hosts[operation.host_id] < self.host_limit
                and (not operation.transfer or self._transfers < self.transfer_limit)
                and (not operation.bulk or self._bulk < self.bulk_limit)
                and (operation.batch_id is None or self._batches[operation.batch_id] < operation.batch_limit))

    @contextmanager
    def scope(self, operation: OperationContext) -> Iterator[OperationContext]:
        parent = current_operation()
        if parent is not None:
            if parent.host_id != operation.host_id:
                raise OperationError("A nested operation must retain its host scope", "invalid_operation")
            parent.check()
            yield parent
            return
        with self._condition:
            operation.check()
            if self._closed:
                raise ExecutionUnavailable()
            can_start = self._eligible(operation) and not any(self._eligible(item) for item in self._queue)
            if not can_start and len(self._queue) >= self.queue_limit:
                raise OperationBusy()
            self._queue.append(operation)
            try:
                while True:
                    operation.check()
                    if self._closed:
                        raise ExecutionUnavailable()
                    first = next((item for item in self._queue if self._eligible(item)), None)
                    if first is operation:
                        break
                    self._condition.wait(timeout=min(0.05, operation.remaining()))
                self._active.add(operation)
                self._hosts[operation.host_id] += 1
                self._transfers += int(operation.transfer)
                self._bulk += int(operation.bulk)
                if operation.batch_id is not None:
                    self._batches[operation.batch_id] += 1
            finally:
                self._queue.remove(operation)
                self._notify()
        token = _current.set(operation)
        try:
            operation.check()
            yield operation
        finally:
            _current.reset(token)
            operation.finish()
            with self._condition:
                self._active.remove(operation)
                self._hosts[operation.host_id] -= 1
                if not self._hosts[operation.host_id]:
                    del self._hosts[operation.host_id]
                self._transfers -= int(operation.transfer)
                self._bulk -= int(operation.bulk)
                if operation.batch_id is not None:
                    self._batches[operation.batch_id] -= 1
                    if not self._batches[operation.batch_id]:
                        del self._batches[operation.batch_id]
                self._notify()

    @asynccontextmanager
    async def async_scope(self, operation: OperationContext):
        """Admit before scheduling a worker, so the thread-pool queue is bounded too."""
        parent = current_operation()
        if parent is not None:
            if parent.host_id != operation.host_id:
                raise OperationError("A nested operation must retain its host scope", "invalid_operation")
            parent.check()
            yield parent
            return
        loop, event = asyncio.get_running_loop(), asyncio.Event()
        waiter = (loop, event)
        with self._condition:
            operation.check()
            if self._closed:
                raise ExecutionUnavailable()
            can_start = self._eligible(operation) and not any(self._eligible(item) for item in self._queue)
            if not can_start and len(self._queue) >= self.queue_limit:
                raise OperationBusy()
            self._queue.append(operation)
            self._async_waiters.add(waiter)
        release_cancel = operation.canceled.subscribe(lambda: loop.call_soon_threadsafe(event.set))
        admitted = False
        try:
            while True:
                with self._condition:
                    event.clear()
                    operation.check()
                    if self._closed:
                        raise ExecutionUnavailable()
                    first = next((item for item in self._queue if self._eligible(item)), None)
                    if first is operation:
                        self._queue.remove(operation)
                        self._active.add(operation)
                        self._hosts[operation.host_id] += 1
                        self._transfers += int(operation.transfer)
                        self._bulk += int(operation.bulk)
                        if operation.batch_id is not None:
                            self._batches[operation.batch_id] += 1
                        admitted = True
                        self._async_waiters.discard(waiter)
                        self._notify()
                        break
                try:
                    await asyncio.wait_for(event.wait(), timeout=operation.remaining())
                except asyncio.TimeoutError:
                    raise OperationTimeout() from None
            with bind_operation(operation):
                yield operation
        except asyncio.CancelledError:
            operation.cancel()
            raise
        finally:
            release_cancel()
            operation.finish()
            with self._condition:
                self._async_waiters.discard(waiter)
                if admitted:
                    self._active.remove(operation)
                    self._hosts[operation.host_id] -= 1
                    if not self._hosts[operation.host_id]:
                        del self._hosts[operation.host_id]
                    self._transfers -= int(operation.transfer)
                    self._bulk -= int(operation.bulk)
                    if operation.batch_id is not None:
                        self._batches[operation.batch_id] -= 1
                        if not self._batches[operation.batch_id]:
                            del self._batches[operation.batch_id]
                elif operation in self._queue:
                    self._queue.remove(operation)
                self._notify()

    def cancel_session(self, session_id: str) -> None:
        with self._condition:
            operations = [item for item in (*self._active, *self._queue) if item.session_id == session_id]
        for operation in operations:
            operation.cancel()
        with self._condition:
            self._notify()

    async def run_async(self, operation: OperationContext, function: Callable, disconnected: asyncio.Event | None = None):
        """Admit business work before a worker starts and collect it on cancel."""
        async with self.async_scope(operation):
            worker = asyncio.create_task(asyncio.to_thread(function))
            gone = asyncio.create_task(disconnected.wait()) if disconnected is not None else None
            try:
                if gone is None:
                    return await asyncio.shield(worker)
                await asyncio.wait({worker, gone}, return_when=asyncio.FIRST_COMPLETED)
                if worker.done():
                    return worker.result()
                operation.cancel()
                with suppress(Exception):
                    await asyncio.wait_for(asyncio.shield(worker), 8)
                raise OperationCancelled()
            except asyncio.CancelledError:
                operation.cancel()
                with suppress(Exception, asyncio.CancelledError):
                    await asyncio.wait_for(asyncio.shield(worker), 8)
                raise
            finally:
                if gone is not None:
                    gone.cancel()
                    with suppress(asyncio.CancelledError):
                        await gone

    def close(self) -> None:
        with self._condition:
            self._closed = True
            operations = [*self._active, *self._queue]
        for operation in operations:
            operation.cancel()
        with self._condition:
            self._notify()

    def snapshot(self) -> dict[str, int]:
        with self._condition:
            return {"active": len(self._active), "queued": len(self._queue), "transfers": self._transfers}

    def wait_idle(self, timeout: float = 8) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True

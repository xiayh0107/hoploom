"""Bounded staging for browser file transfers.

A browser transfer always passes through a private local file: sftp needs one
to put an upload, and a download is size-checked there before any byte
reaches the browser. These helpers keep that staging bounded. A transfer
takes a slot before its request body is read, an upload is size-capped while
it streams and written once (off the event loop) straight into the private
runtime directory, and a staged download is sent in fixed chunks with its
directory removed however the response ends. A transfer is stopped when its
client goes away, and reports how far its host-side work has come while the
client waits.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import threading
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import anyio.to_thread
from starlette.requests import ClientDisconnect
from starlette.responses import StreamingResponse

try:
    from python_multipart.multipart import MultipartParser, parse_options_header
except ModuleNotFoundError:  # python-multipart < 0.0.13
    from multipart.multipart import MultipartParser, parse_options_header  # type: ignore[no-redef]

from .ssh_runner import FileOperationError
from .validation import ValidationError


WRITE_CHUNK_BYTES = 1024 * 1024
SEND_CHUNK_BYTES = 64 * 1024
# Room for the boundaries, part headers and the path/overwrite fields around
# the file itself; a declared body larger than limit + this is refused unread.
MULTIPART_OVERHEAD_BYTES = 64 * 1024
FIELD_LIMIT_BYTES = 8 * 1024
TRUE_VALUES = {"1", "true", "t", "yes", "y", "on"}
FALSE_VALUES = {"0", "false", "f", "no", "n", "off"}


TRANSFER_ID_PATTERN = r"^[A-Za-z0-9_-]{16,64}$"


class TransferProgress:
    """What one transfer's host-side work has done, read by its waiting client."""

    def __init__(self) -> None:
        self.phase = "waiting"
        self.total: int | None = None
        self.measure: Callable[[], int | None] | None = None
        self.best: int | None = None

    def begin(self, total: int | None, measure: Callable[[], int | None]) -> None:
        """The runner's meter: sftp started, `measure` counts its bytes."""
        self.total, self.measure, self.phase = total, measure, "host"

    def snapshot(self) -> dict[str, Any]:
        reading = None
        if self.measure is not None:
            try:
                reading = self.measure()
            except Exception:  # noqa: BLE001 - progress is optional, never a failure
                reading = None
        # Counters only grow; a closed file keeps the last value it reported.
        if reading is not None:
            self.best = max(self.best or 0, reading)
        done = self.best
        if done is not None and self.total is not None:
            done = min(done, self.total)
        return {"phase": self.phase, "bytes": done, "total": self.total}


@dataclass
class ProgressBoard:
    """Live transfers by (browser session, client-chosen id); gone when the request ends."""

    entries: dict[tuple[str, str], TransferProgress] = field(default_factory=dict)

    def open(self, session: str, transfer_id: str | None) -> tuple[TransferProgress, Callable[[], None]]:
        progress = TransferProgress()
        if transfer_id is None:
            return progress, lambda: None
        if not re.fullmatch(TRANSFER_ID_PATTERN, transfer_id):
            raise ValidationError("invalid transfer id")
        key = (session, transfer_id)
        if key in self.entries:
            raise ValidationError("transfer id is already in use")
        self.entries[key] = progress

        def close() -> None:
            if self.entries.get(key) is progress:
                del self.entries[key]

        return progress, close

    def read(self, session: str, transfer_id: str) -> dict[str, Any] | None:
        progress = self.entries.get((session, transfer_id))
        return None if progress is None else progress.snapshot()


class DisconnectWatch:
    """Sets `cancel` when the client goes away while its request is served.

    Only use it once the request body has been read: it consumes receive().
    """

    def __init__(self, request: Any) -> None:
        self.request = request
        self.cancel = threading.Event()
        self.gone = asyncio.Event()
        self.task: asyncio.Task | None = None

    async def _watch(self) -> None:
        while (await self.request.receive())["type"] != "http.disconnect":
            pass
        self.cancel.set()
        self.gone.set()

    async def __aenter__(self) -> "DisconnectWatch":
        self.task = asyncio.create_task(self._watch())
        return self

    async def __aexit__(self, kind, _value, _traceback) -> None:
        if kind is not None:
            # The handler failed or was cancelled; stop any work it started.
            self.cancel.set()
        assert self.task is not None
        self.task.cancel()
        with suppress(asyncio.CancelledError):
            await self.task

    async def unless_gone(self, awaitable: Any) -> Any:
        """Await `awaitable`, or raise ClientDisconnect if the client leaves first."""
        work = asyncio.ensure_future(awaitable)
        gone = asyncio.ensure_future(self.gone.wait())
        try:
            await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            gone.cancel()
        if work.done():
            return work.result()
        work.cancel()
        with suppress(asyncio.CancelledError):
            await work
        raise ClientDisconnect()


class TransferBusy(Exception):
    """Every transfer slot and every queue position is taken."""


class TransferGate:
    """Process-wide cap on staged browser transfers.

    A few transfers run, a few more wait, and the rest are refused at once
    rather than staging bytes they cannot use yet. Waiters are plain futures
    created in the running loop, so the gate is not tied to one event loop.
    """

    def __init__(self, active: int = 2, waiting: int = 8) -> None:
        self.limit = active
        self.waiting_limit = waiting
        self.running = 0
        self.waiters: deque[asyncio.Future[None]] = deque()

    async def acquire(self) -> Callable[[], None]:
        """Wait for a slot; return an idempotent release for it."""
        if self.running < self.limit:
            self.running += 1
        else:
            if len(self.waiters) >= self.waiting_limit:
                raise TransferBusy("too many browser transfers are in progress; try again shortly")
            waiter = asyncio.get_running_loop().create_future()
            self.waiters.append(waiter)
            try:
                await waiter
            except BaseException:
                if waiter.done() and not waiter.cancelled():
                    # The slot was handed over just as this waiter was cancelled.
                    self._release()
                else:
                    self.waiters.remove(waiter)
                raise
        released = False

        def release() -> None:
            nonlocal released
            if not released:
                released = True
                self._release()

        return release

    def _release(self) -> None:
        while self.waiters:
            waiter = self.waiters.popleft()
            if not waiter.done():
                waiter.set_result(None)  # Hand the slot over; the count stays.
                return
        self.running -= 1


def too_large(limit: int, command: str) -> FileOperationError:
    return FileOperationError(
        f"{'upload exceeds' if command == 'put' else 'file is larger than'} the "
        f"{limit // (1024 * 1024)} MB web transfer limit; use hoploom {command} instead",
        "too_large",
    )


def make_staging(prefix: str) -> Path:
    from .paths import runtime_dir

    return Path(tempfile.mkdtemp(dir=runtime_dir(), prefix=prefix))


@dataclass
class StagedUpload:
    staging: Path
    source: Path
    path: str
    overwrite: bool

    def discard(self) -> None:
        shutil.rmtree(self.staging, ignore_errors=True)


class _UploadForm:
    """Callback state for one multipart body with fields file, path, overwrite."""

    def __init__(self, source: Path, limit: int) -> None:
        self.source = source
        self.limit = limit
        self.handle: Any = None
        self.file_bytes = 0
        self.file_seen = False
        self.pending = bytearray()
        self.fields: dict[str, bytearray] = {}
        self.part: str | None = None
        self.header_field = bytearray()
        self.header_value = bytearray()
        self.disposition = b""
        self.ended = False

    def callbacks(self) -> dict[str, Callable[..., None]]:
        return {
            "on_part_begin": self.on_part_begin,
            "on_header_field": self.on_header_field,
            "on_header_value": self.on_header_value,
            "on_header_end": self.on_header_end,
            "on_headers_finished": self.on_headers_finished,
            "on_part_data": self.on_part_data,
            "on_end": self.on_end,
        }

    def on_part_begin(self) -> None:
        self.part = None
        self.disposition = b""
        self.header_field.clear()
        self.header_value.clear()

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self.header_field += data[start:end]
        self._bound(self.header_field)

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self.header_value += data[start:end]
        self._bound(self.header_value)

    def on_header_end(self) -> None:
        if bytes(self.header_field).lower() == b"content-disposition":
            self.disposition = bytes(self.header_value)
        self.header_field.clear()
        self.header_value.clear()

    def on_headers_finished(self) -> None:
        _kind, params = parse_options_header(self.disposition)
        name = params.get(b"name", b"").decode("latin-1")
        if name == "file":
            if self.file_seen:
                raise ValidationError("upload must contain exactly one file")
            self.file_seen = True
            self.handle = self.source.open("xb")
        elif name in self.fields:
            raise ValidationError(f"upload field {name or '(unnamed)'} is repeated")
        else:
            self.fields[name] = bytearray()
        self.part = name

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        if self.part == "file":
            self.file_bytes += end - start
            if self.file_bytes > self.limit:
                raise too_large(self.limit, "put")
            self.pending += data[start:end]
        elif self.part is not None:
            self.fields[self.part] += data[start:end]
            self._bound(self.fields[self.part])

    def on_end(self) -> None:
        self.ended = True

    @staticmethod
    def _bound(value: bytearray) -> None:
        if len(value) > FIELD_LIMIT_BYTES:
            raise ValidationError("upload form field is too large")

    async def flush(self, *, final: bool = False) -> None:
        if self.handle is None or (not final and len(self.pending) < WRITE_CHUNK_BYTES):
            return
        if self.pending:
            data = bytes(self.pending)
            self.pending.clear()
            await anyio.to_thread.run_sync(self.handle.write, data)

    def text(self, name: str) -> str | None:
        value = self.fields.get(name)
        if value is None:
            return None
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationError(f"upload field {name} must be UTF-8") from exc


async def receive_upload(request: Any, *, limit: int) -> StagedUpload:
    """Stream one multipart upload into a fresh private staging directory.

    The caller holds a transfer slot and has authenticated the request; no
    byte of the body is read before this runs. The body is consumed exactly
    once, here, so nothing else may listen on the request for a disconnect.
    """
    kind, params = parse_options_header(request.headers.get("content-type", ""))
    boundary = params.get(b"boundary")
    if kind != b"multipart/form-data" or not boundary:
        raise ValidationError("upload must be multipart/form-data")
    declared = request.headers.get("content-length")
    if declared is not None:
        if not declared.isdigit():
            raise ValidationError("invalid Content-Length")
        if int(declared) > limit + MULTIPART_OVERHEAD_BYTES:
            raise too_large(limit, "put")
    staging = make_staging("ul-")
    # The staged name is fixed: an untrusted filename never becomes a path.
    form = _UploadForm(staging / "upload", limit)
    received = 0
    try:
        parser = MultipartParser(boundary, form.callbacks())
        async for chunk in request.stream():
            received += len(chunk)
            if received > limit + MULTIPART_OVERHEAD_BYTES:
                raise too_large(limit, "put")
            parser.write(chunk)
            await form.flush()
        parser.finalize()
        await form.flush(final=True)
        if form.handle is not None:
            await anyio.to_thread.run_sync(form.handle.close)
        if not form.ended or not form.file_seen:
            raise ValidationError("upload must contain a file")
        path = form.text("path")
        if path is None:
            raise ValidationError("path is required")
        overwrite_text = (form.text("overwrite") or "false").strip().lower()
        if overwrite_text not in TRUE_VALUES | FALSE_VALUES:
            raise ValidationError("overwrite must be true or false")
        return StagedUpload(staging, form.source, path, overwrite_text in TRUE_VALUES)
    except BaseException:
        if form.handle is not None:
            form.handle.close()
        shutil.rmtree(staging, ignore_errors=True)
        raise


class StagedFileResponse(StreamingResponse):
    """Send a staged download in fixed chunks, then delete its directory.

    Cleanup wraps the whole ASGI response rather than running as a background
    task, so a finished send, a client that disconnects, a failed send and a
    cancelled task all close the file, remove the staging directory and give
    the transfer slot back. Cleanup is synchronous so cancellation cannot skip
    it.
    """

    def __init__(
        self, source: Path, staging: Path, *, headers: dict[str, str], release: Callable[[], None],
    ) -> None:
        self._staging = staging
        self._release = release
        self._handle = source.open("rb")
        size = os.fstat(self._handle.fileno()).st_size
        super().__init__(
            self._chunks(), media_type="application/octet-stream",
            headers={**headers, "Content-Length": str(size)},
        )

    async def _chunks(self):
        # anyio waits for a running read on cancellation, so close() never
        # races a read still in flight on a worker thread.
        while chunk := await anyio.to_thread.run_sync(self._handle.read, SEND_CHUNK_BYTES):
            yield chunk

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.close()

    def close(self) -> None:
        self._handle.close()
        shutil.rmtree(self._staging, ignore_errors=True)
        self._release()

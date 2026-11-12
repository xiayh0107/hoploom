"""Browser transfer staging: gated before the body, bounded while streaming,
and cleaned up however the response ends.

These drive the ASGI app directly so a test can count how much of a request
body the server pulled and make the client vanish mid-response.
"""
from __future__ import annotations

import asyncio
import threading
import time
from contextlib import suppress

import anyio
import pytest

pytest.importorskip("fastapi")

from ssh_server_manager import webapp
from ssh_server_manager.db import Database
from ssh_server_manager.vault import MemoryVault
from ssh_server_manager.web_transfers import (
    MULTIPART_OVERHEAD_BYTES, SEND_CHUNK_BYTES, TransferBusy, TransferGate,
)

BOUNDARY = "hoploom-test-boundary"


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("SSM_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SSM_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("SSM_MANAGED_SSH_CONFIG", str(tmp_path / "managed.conf"))
    monkeypatch.setenv("SSM_ORIGINAL_SSH_CONFIG", str(tmp_path / "missing.conf"))
    monkeypatch.setattr(webapp, "get_vault", lambda: MemoryVault())
    database = Database()
    database.create_server(alias="box", hostname="box.example.invalid", username="alice")
    return webapp.create_app(database, launch_token="fixture-launch", port=8765)


def staged(tmp_path, prefix):
    root = tmp_path / "runtime"
    return sorted(root.glob(f"{prefix}*")) if root.exists() else []


def session_headers(app, *, csrf=True):
    identifier, session = app.state.web.create_session()
    headers = {"cookie": f"{webapp.SESSION_COOKIE}={identifier}", "origin": "http://localhost:8765"}
    if csrf:
        headers["x-csrf-token"] = session.csrf
    return headers


def multipart(*parts: tuple[str, bytes, str | None]) -> bytes:
    body = b""
    for name, value, filename in parts:
        disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        body += f"--{BOUNDARY}\r\nContent-Disposition: {disposition}\r\n".encode()
        if filename:
            body += b"Content-Type: application/octet-stream\r\n"
        body += b"\r\n" + value + b"\r\n"
    return body + f"--{BOUNDARY}--\r\n".encode()


def chunks_of(body: bytes, size: int = 64 * 1024) -> list[bytes]:
    return [body[index:index + size] for index in range(0, len(body), size)] or [b""]


class Exchange:
    def __init__(self) -> None:
        self.consumed = 0
        self.status: int | None = None
        self.headers: dict[str, str] = {}
        self.bodies: list[bytes] = []
        self.error: BaseException | None = None

    @property
    def body(self) -> bytes:
        return b"".join(self.bodies)


def call(app, path, *, headers, body_chunks=(), content_length=True, vanish_after_first_chunk=False,
         vanish_after_chunks: int | None = None, spec_version: str = "2.3",
         vanish_when: threading.Event | None = None, query: str = "", method: str = "POST") -> Exchange:
    """One ASGI request; counts body chunks pulled and can drop the client.

    A dropped client behaves as uvicorn (ASGI spec 2.3) reports one: receive
    answers http.disconnect and later sends are silently discarded. Under spec
    2.4 a send to a vanished client raises OSError instead.
    """
    exchange = Exchange()
    pending = list(body_chunks)
    header_items = {"host": "localhost:8765", **headers}
    if content_length:
        header_items["content-length"] = str(sum(len(chunk) for chunk in pending))
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": spec_version}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query.encode(),
        "root_path": "", "client": ("127.0.0.1", 50000), "server": ("localhost", 8765),
        "headers": [(key.encode(), value.encode()) for key, value in header_items.items()],
    }
    gone = anyio.Event()

    async def receive():
        if vanish_after_chunks is not None and exchange.consumed >= vanish_after_chunks:
            gone.set()
        if pending and not gone.is_set():
            exchange.consumed += 1
            chunk = pending.pop(0)
            return {"type": "http.request", "body": chunk, "more_body": bool(pending)}
        # Another thread (a fake sftp) can make the client leave mid-request.
        while not gone.is_set() and not (vanish_when is not None and vanish_when.is_set()):
            await anyio.sleep(0.01)
        gone.set()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            exchange.status = message["status"]
            exchange.headers = {key.decode(): value.decode() for key, value in message["headers"]}
        elif message["type"] == "http.response.body" and message.get("body"):
            if gone.is_set():
                if spec_version >= "2.4":
                    raise OSError("client went away")
                return
            exchange.bodies.append(message["body"])
            if vanish_after_first_chunk:
                gone.set()

    async def run():
        try:
            await app(scope, receive, send)
        except BaseException as exc:  # noqa: BLE001 - the test inspects it
            exchange.error = exc
        finally:
            gone.set()

    anyio.run(run)
    return exchange


@pytest.mark.parametrize("executor_name", ["python", "rust"])
def test_directory_disconnect_collects_its_process_without_recording_host_failure(app, tmp_path, monkeypatch, executor_name):
    import sys
    from ssh_server_manager import execution
    delegate = execution.get_executor(executor_name)
    vanished = threading.Event()
    tasks = []
    class ObservedExecutor:
        def start(self, spec, operation=None):
            task = delegate.start(spec, operation)
            tasks.append(task)
            assert task.wait_started(3) is not None
            vanished.set()
            return task
    monkeypatch.setattr(execution, "get_executor", lambda: ObservedExecutor())
    runner = app.state.services.runner()
    runner.fast_listing = False
    monkeypatch.setattr(runner, "_sftp_command", lambda *_a, **_kw: [sys.executable, "-c", "import time;time.sleep(60)"])
    result = call(app, "/api/v1/hosts/box/files", headers=session_headers(app), body_chunks=[b""],
                  vanish_when=vanished, method="GET")
    assert result.error is None
    assert tasks[0].wait(1).reason == "canceled"
    assert app.state.services.database.get_server("box")["last_test_status"] is None
    assert app.state.services.operations.snapshot() == {"active": 0, "queued": 0, "transfers": 0}
    assert error_log(tmp_path) == ""


@pytest.mark.parametrize("prefix", ["/api/v1/hosts", "/api/servers"])
@pytest.mark.parametrize("case", ["no-session", "no-csrf", "declared-oversize", "queue-full"])
def test_an_upload_refused_up_front_never_reads_its_body(app, tmp_path, monkeypatch, prefix, case):
    called = []
    monkeypatch.setattr(app.state.services.files, "upload", lambda *a, **k: called.append(a))
    monkeypatch.setattr(webapp, "MAX_WEB_TRANSFER_BYTES", 1024)
    body = multipart(("path", b"/srv/file", None), ("file", b"x" * (1024 + MULTIPART_OVERHEAD_BYTES + 1), "file"))
    headers = {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}
    if case != "no-session":
        headers |= session_headers(app, csrf=case != "no-csrf")
    if case == "queue-full":
        app.state.web.transfers = TransferGate(active=0, waiting=0)

    result = call(app, f"{prefix}/box/upload", headers=headers, body_chunks=chunks_of(body))

    expected = {"no-session": 401, "no-csrf": 403, "queue-full": 503,
                "declared-oversize": 413 if prefix.endswith("hosts") else 400}[case]
    assert result.status == expected
    assert result.consumed == 0
    assert called == []
    assert staged(tmp_path, "ul-") == []
    if case == "queue-full":
        import json
        assert json.loads(result.body)["error_code"] == "busy"
        assert result.headers["retry-after"] == "5"


def test_an_upload_without_a_length_stops_reading_past_the_limit(app, tmp_path, monkeypatch):
    # The embedded plugin proxy forwards uploads chunked, with no length.
    limit = 1024 * 1024
    monkeypatch.setattr(webapp, "MAX_WEB_TRANSFER_BYTES", limit)
    monkeypatch.setattr(app.state.services.files, "upload", lambda *a, **k: pytest.fail("must not upload"))
    body = multipart(("path", b"/srv/file", None), ("file", b"x" * (8 * limit), "file"))
    chunks = chunks_of(body)
    headers = session_headers(app) | {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}

    result = call(app, "/api/v1/hosts/box/upload", headers=headers, body_chunks=chunks, content_length=False)

    assert result.status == 413
    assert result.consumed * 64 * 1024 <= limit + 2 * 64 * 1024
    assert result.consumed < len(chunks)
    assert staged(tmp_path, "ul-") == []
    assert app.state.web.transfers.running == 0


def test_an_upload_of_many_small_fields_stops_at_the_body_cap(app, tmp_path, monkeypatch):
    # Each field is small, so only the whole-body cap can stop this one.
    monkeypatch.setattr(webapp, "MAX_WEB_TRANSFER_BYTES", 1024)
    monkeypatch.setattr(app.state.services.files, "upload", lambda *a, **k: pytest.fail("must not upload"))
    body = multipart(*[(f"note{index}", b"n" * 64, None) for index in range(20_000)])
    chunks = chunks_of(body)
    headers = session_headers(app) | {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}

    result = call(app, "/api/v1/hosts/box/upload", headers=headers, body_chunks=chunks, content_length=False)

    assert result.status == 413
    assert result.consumed < len(chunks)
    assert staged(tmp_path, "ul-") == []


@pytest.mark.parametrize("path_first", [True, False])
@pytest.mark.parametrize("content_length", [True, False])  # The plugin proxy sends no length.
def test_an_upload_streams_once_into_private_staging(app, tmp_path, monkeypatch, path_first, content_length):
    payload = bytes(range(256)) * (3 * 4096 + 7)  # > 3 MiB: several write flushes
    remote = "/srv/数据/报告 v2.txt"
    seen = {}

    def upload(identifier, source, path, *, overwrite, **_live):
        seen.update(identifier=identifier, parent=source.parent.parent, name=source.name,
                    data=source.read_bytes(), path=path, overwrite=overwrite)
        return {"alias": "box", "direction": "upload", "remote_path": path, "bytes": len(seen["data"]), "latency_ms": 1}

    monkeypatch.setattr(app.state.services.files, "upload", upload)
    fields = [("path", remote.encode(), None), ("overwrite", b"true", None)]
    # A hostile part filename never becomes a local path.
    file_part = ("file", payload, "../../escape")
    body = multipart(*(fields + [file_part] if path_first else [file_part] + fields))
    headers = session_headers(app) | {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}

    result = call(app, "/api/v1/hosts/box/upload", headers=headers, body_chunks=chunks_of(body),
                  content_length=content_length)

    assert result.status == 200, result.body
    assert seen["data"] == payload
    assert seen["name"] == "upload"
    assert seen["parent"] == (tmp_path / "runtime").resolve()
    assert seen["path"] == remote and seen["overwrite"] is True
    assert staged(tmp_path, "ul-") == []
    assert app.state.web.transfers.running == 0


@pytest.mark.parametrize("body, content_type", [
    (multipart(("path", b"/srv/file", None)), None),
    (multipart(("path", b"/srv/file", None), ("file", b"a", "a"), ("file", b"b", "b")), None),
    (multipart(("file", b"a", "a")), None),
    (multipart(("path", b"/srv/file", None), ("path", b"/srv/other", None), ("file", b"a", "a")), None),
    (multipart(("path", b"/srv/file", None), ("overwrite", b"maybe", None), ("file", b"a", "a")), None),
    (multipart(("path", b"/" + b"p" * (9 * 1024), None), ("file", b"a", "a")), None),
    (multipart(("path", b"\xff\xfe", None), ("file", b"a", "a")), None),
    (multipart(("path", b"/srv/file", None), ("file", b"a", "a"))[:-8], None),
    (b'{"path": "/srv/file"}', "application/json"),
])
def test_a_malformed_upload_form_is_refused_and_leaves_nothing(app, tmp_path, monkeypatch, body, content_type):
    monkeypatch.setattr(app.state.services.files, "upload", lambda *a, **k: pytest.fail("must not upload"))
    headers = session_headers(app) | {"content-type": content_type or f"multipart/form-data; boundary={BOUNDARY}"}

    result = call(app, "/api/v1/hosts/box/upload", headers=headers, body_chunks=chunks_of(body))

    assert result.status == 400, result.body
    assert staged(tmp_path, "ul-") == []
    assert app.state.web.transfers.running == 0


def write_download(size):
    def download(identifier, remote_path, target, *, max_bytes=None, **_live):
        target.write_bytes(b"d" * size)
        return {"bytes": size}
    return download


def test_a_download_streams_in_bounded_chunks_with_its_length(app, tmp_path, monkeypatch):
    size = 3 * SEND_CHUNK_BYTES + 5
    monkeypatch.setattr(app.state.services.files, "download", write_download(size))
    headers = session_headers(app) | {"content-type": "application/json"}

    result = call(app, "/api/v1/hosts/box/download", headers=headers,
                  body_chunks=[b'{"path": "/srv/r\xc3\xa9sum\xc3\xa9.pdf"}'])

    assert result.status == 200
    assert result.headers["content-length"] == str(size)
    assert result.headers["content-disposition"] == "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
    assert result.body == b"d" * size
    assert max(len(chunk) for chunk in result.bodies) <= SEND_CHUNK_BYTES
    assert staged(tmp_path, "dl-") == []
    assert app.state.web.transfers.running == 0


def error_log(tmp_path):
    path = tmp_path / "runtime" / "ui-errors.log"
    return path.read_text(encoding="utf-8") if path.exists() else ""


@pytest.mark.parametrize("spec_version", ["2.3", "2.4"])
def test_a_download_cleans_up_quietly_when_the_client_disconnects(app, tmp_path, monkeypatch, spec_version):
    monkeypatch.setattr(app.state.services.files, "download", write_download(8 * SEND_CHUNK_BYTES))
    headers = session_headers(app) | {"content-type": "application/json"}

    result = call(app, "/api/v1/hosts/box/download", headers=headers,
                  body_chunks=[b'{"path": "/srv/file"}'], vanish_after_first_chunk=True,
                  spec_version=spec_version)

    assert len(result.bodies) == 1
    assert staged(tmp_path, "dl-") == []
    assert app.state.web.transfers.running == 0
    if spec_version == "2.3":  # uvicorn's spec: a cancelled transfer is not a fault.
        assert result.error is None and error_log(tmp_path) == ""


def test_an_upload_cancelled_mid_body_cleans_up_quietly(app, tmp_path, monkeypatch):
    monkeypatch.setattr(app.state.services.files, "upload", lambda *a, **k: pytest.fail("must not upload"))
    body = multipart(("path", b"/srv/file", None), ("file", b"x" * (2 * 1024 * 1024), "file"))
    headers = session_headers(app) | {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}

    result = call(app, "/api/v1/hosts/box/upload", headers=headers, body_chunks=chunks_of(body),
                  vanish_after_chunks=3)

    assert result.consumed == 3
    assert staged(tmp_path, "ul-") == []
    assert app.state.web.transfers.running == 0
    assert result.error is None and error_log(tmp_path) == ""


def test_a_failed_download_releases_its_slot_and_staging(app, tmp_path, monkeypatch):
    def fail(*_args, **_kwargs):
        from ssh_server_manager.ssh_runner import FileOperationError
        raise FileOperationError("remote file vanished", "not_found")

    monkeypatch.setattr(app.state.services.files, "download", fail)
    headers = session_headers(app) | {"content-type": "application/json"}

    result = call(app, "/api/v1/hosts/box/download", headers=headers, body_chunks=[b'{"path": "/srv/file"}'])

    assert result.status == 404
    assert staged(tmp_path, "dl-") == []
    assert app.state.web.transfers.running == 0


def test_the_transfer_gate_queues_hands_over_and_refuses():
    async def scenario():
        gate = TransferGate(active=1, waiting=1)
        first = await gate.acquire()
        queued = asyncio.create_task(gate.acquire())
        await asyncio.sleep(0)
        with pytest.raises(TransferBusy):
            await gate.acquire()
        first()
        first()  # Releasing twice must not free a second slot.
        second = await asyncio.wait_for(queued, 1)
        assert gate.running == 1 and not gate.waiters
        abandoned = asyncio.create_task(gate.acquire())
        await asyncio.sleep(0)
        abandoned.cancel()
        with suppress(asyncio.CancelledError):
            await abandoned
        assert not gate.waiters
        second()
        assert gate.running == 0

    asyncio.run(asyncio.wait_for(scenario(), 5))


def leaves_during_sftp(record):
    """A fake transfer: the client vanishes while it runs; it waits to be cancelled."""
    vanish = threading.Event()

    def transfer(*_args, cancel, meter, **_options):
        meter(10, lambda: 4)
        vanish.set()
        record["cancelled"] = cancel.wait(5)
        from ssh_server_manager.ssh_runner import FileOperationError
        raise FileOperationError("transfer canceled", "canceled")

    return vanish, transfer


@pytest.mark.parametrize("kind", ["download", "upload"])
def test_a_client_that_leaves_stops_the_host_transfer_and_frees_its_slot(app, tmp_path, monkeypatch, kind):
    record = {}
    vanish, transfer = leaves_during_sftp(record)
    monkeypatch.setattr(app.state.services.files, kind, transfer)
    if kind == "download":
        headers = session_headers(app) | {"content-type": "application/json"}
        body = [b'{"path": "/srv/file"}']
    else:
        headers = session_headers(app) | {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}
        body = chunks_of(multipart(("path", b"/srv/file", None), ("file", b"x" * 1000, "file")))

    result = call(app, f"/api/v1/hosts/box/{kind}", headers=headers, body_chunks=body, vanish_when=vanish,
                  query="transfer_id=" + "a" * 32)

    assert record == {"cancelled": True}
    assert app.state.web.transfers.running == 0
    assert app.state.web.progress.entries == {}
    assert staged(tmp_path, "dl-") == staged(tmp_path, "ul-") == []
    assert result.error is None and error_log(tmp_path) == ""


def test_a_download_waiting_for_a_slot_leaves_the_queue_with_its_client(app, tmp_path, monkeypatch):
    monkeypatch.setattr(app.state.services.files, "download", lambda *a, **k: pytest.fail("must not start"))
    app.state.web.transfers = TransferGate(active=0, waiting=1)
    vanish = threading.Event()
    threading.Timer(0.3, vanish.set).start()
    headers = session_headers(app) | {"content-type": "application/json"}

    result = call(app, "/api/v1/hosts/box/download", headers=headers, body_chunks=[b'{"path": "/srv/file"}'], vanish_when=vanish)

    assert not app.state.web.transfers.waiters
    assert staged(tmp_path, "dl-") == []
    assert result.error is None and error_log(tmp_path) == ""


def test_progress_is_visible_to_its_own_session_only_while_the_transfer_runs(app, monkeypatch):
    from fastapi.testclient import TestClient

    transfer_id = "b" * 32
    own = session_headers(app)
    other = session_headers(app)
    seen = {}
    finish = threading.Event()

    def download(identifier, remote_path, target, *, cancel, meter, **_options):
        count = {"value": None}
        meter(400, lambda: count["value"])
        seen["unknown"] = True
        finish.wait(5)
        target.write_bytes(b"d" * 400)
        return {"bytes": 400}

    monkeypatch.setattr(app.state.services.files, "download", download)
    with TestClient(app, base_url="http://localhost:8765") as client:
        def progress(headers):
            return client.get(f"/api/v1/transfers/{transfer_id}", headers={"cookie": headers["cookie"]})

        assert progress(own).status_code == 404
        worker = threading.Thread(target=lambda: seen.setdefault("response", client.post(
            f"/api/v1/hosts/box/download?transfer_id={transfer_id}", headers=own, json={"path": "/srv/file"})))
        worker.start()
        deadline = time.monotonic() + 5
        while "unknown" not in seen and time.monotonic() < deadline:
            time.sleep(0.01)
        assert progress(own).json() == {"phase": "host", "bytes": None, "total": 400}
        assert progress(other).status_code == 404
        # A second request may not claim an id that is already in use.
        clash = client.post(f"/api/v1/hosts/box/download?transfer_id={transfer_id}", headers=own, json={"path": "/srv/other"})
        assert clash.status_code == 400
        finish.set()
        worker.join(5)
        assert seen["response"].status_code == 200
        assert progress(own).status_code == 404
        invalid = client.post("/api/v1/hosts/box/download?transfer_id=short", headers=own, json={"path": "/srv/file"})
        assert invalid.status_code == 422


def test_progress_counts_only_grow_and_stay_within_the_total():
    from ssh_server_manager.web_transfers import TransferProgress

    progress = TransferProgress()
    assert progress.snapshot() == {"phase": "waiting", "bytes": None, "total": None}
    readings = iter([5, None, 3, 50])
    progress.begin(20, lambda: next(readings))
    assert [progress.snapshot()["bytes"] for _ in range(4)] == [5, 5, 5, 20]

    failing = TransferProgress()
    failing.begin(None, lambda: 1 / 0)
    assert failing.snapshot() == {"phase": "host", "bytes": None, "total": None}


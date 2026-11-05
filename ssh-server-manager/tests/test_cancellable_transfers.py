"""Browser transfers through SSHRunner: stoppable, metered, and an explicit
overwrite that a cancel or failure never leaves half-written."""
from __future__ import annotations

import sys
import threading
import time

import pytest

from ssh_server_manager.db import Database
from ssh_server_manager.ssh_runner import FileOperationError, SSHRunner


@pytest.fixture
def runner(tmp_path, monkeypatch):
    database = Database(tmp_path / "hosts.db")
    database.create_server(alias="box", hostname="box.example", username="alice", port=22)
    monkeypatch.setenv("SSM_MANAGED_SSH_CONFIG", str(tmp_path / "managed.conf"))
    monkeypatch.setenv("SSM_ORIGINAL_SSH_CONFIG", str(tmp_path / "missing.conf"))
    monkeypatch.setenv("SSM_RUNTIME_DIR", str(tmp_path / "runtime"))
    return SSHRunner(database, ssh_binary="ssh", sftp_binary="sftp")


def metadata(kind="file", size=12):
    return {"type": kind, "size": size, "uid": 1, "gid": 1, "owner": "a", "group": "a",
            "link_target": None, "modified_at": None}


def missing(*_args, **_options):
    raise FileOperationError("missing", "not_found")


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "upload.bin"
    path.write_bytes(b"new contents")
    return path


def test_batch_paths_escape_backslashes_and_quotes_for_sftp():
    # sftp -b parses double-quoted arguments with backslash escapes, so a Win32
    # path keeps its separators only when each one is doubled.
    assert SSHRunner._sftp_path(r"C:\Users\alice\upload.bin") == r'"C:\\Users\\alice\\upload.bin"'
    assert SSHRunner._sftp_path('/srv/a "b"') == r'"/srv/a \"b\""'


def test_overwrite_stages_beside_the_target_and_renames_over_it(runner, source, monkeypatch):
    batches = []
    monkeypatch.setattr(runner, "stat_file", lambda *_a, **_o: metadata())
    monkeypatch.setattr(runner, "_run_transfer", lambda *_a, **options: (batches.append(options) or (0, "", "")))
    runner.upload("box", source, "/srv/app.conf", overwrite=True, cancel=threading.Event())
    assert len(batches) == 1
    put, rename = batches[0]["batch"].splitlines()
    assert put.startswith(f'@put -p {SSHRunner._sftp_path(str(source))} "/srv/.ssm-upload-')
    staged = put.split()[-1]
    assert rename == f'@rename {staged} "/srv/app.conf"'
    assert batches[0]["batch_mode"] is True and batches[0]["cancel"] is not None


@pytest.mark.parametrize("failure", ["canceled", "error"])
def test_a_stopped_or_failed_overwrite_removes_only_its_staged_copy(runner, source, monkeypatch, failure):
    batches = []
    monkeypatch.setattr(runner, "stat_file", missing)

    def transfer(*_args, **options):
        batches.append(options["batch"])
        if len(batches) == 1:
            if failure == "canceled":
                raise FileOperationError("transfer canceled", "canceled")
            return 1, "", "remote write: Permission denied"
        return 0, "", ""

    monkeypatch.setattr(runner, "_run_transfer", transfer)
    with pytest.raises(FileOperationError) as error:
        runner.upload("box", source, "/srv/app.conf", overwrite=True, cancel=threading.Event())
    assert error.value.error_code == ("canceled" if failure == "canceled" else "permission_denied")
    assert len(batches) == 2
    assert batches[1].startswith('@rm "/srv/.ssm-upload-') and '"/srv/app.conf"' not in batches[1]


@pytest.mark.parametrize("message", [
    'Couldn\'t rename file "/srv/.ssm-upload-x" to "/srv/app.conf": Failure',  # OpenSSH before 10
    'remote rename "/srv/.ssm-upload-x" to "/srv/app.conf": Failure',  # OpenSSH 10
])
def test_a_server_that_will_not_rename_over_a_file_gets_the_plain_put(runner, source, monkeypatch, message):
    batches = []
    monkeypatch.setattr(runner, "stat_file", lambda *_a, **_o: metadata())

    def transfer(*_args, **options):
        batches.append(options)
        if "@rename" in options["batch"]:
            return 1, "", message
        return 0, "", ""

    monkeypatch.setattr(runner, "_run_transfer", transfer)
    runner.upload("box", source, "/srv/app.conf", overwrite=True, cancel=threading.Event())
    assert ["@rename" in item["batch"] for item in batches] == [True, False, False]
    assert batches[1]["batch"].startswith('@rm "/srv/.ssm-upload-')
    assert batches[2]["batch"] == f'@put -p {SSHRunner._sftp_path(str(source))} "/srv/app.conf"\n@quit\n'
    # The fallback writes the target in place, so it cannot honour a cancel.
    assert not batches[2]["cancel"].is_set()


def test_a_symlink_target_is_written_through_not_replaced(runner, source, monkeypatch):
    batches = []
    monkeypatch.setattr(runner, "stat_file", lambda *_a, **_o: metadata(kind="symlink"))
    monkeypatch.setattr(runner, "_run_transfer", lambda *_a, **options: (batches.append(options["batch"]) or (0, "", "")))
    runner.upload("box", source, "/srv/current", overwrite=True, cancel=threading.Event())
    assert batches == [f'@put -p {SSHRunner._sftp_path(str(source))} "/srv/current"\n@quit\n']


def test_a_cancel_before_sftp_starts_runs_nothing(runner, source, tmp_path, monkeypatch):
    cancel = threading.Event()
    cancel.set()
    monkeypatch.setattr(runner, "stat_file", lambda *_a, **_o: metadata() if _o.get("follow_symlinks", True) else (_ for _ in ()).throw(FileOperationError("m", "not_found")))
    monkeypatch.setattr(runner, "_run_transfer", lambda *_a, **_o: pytest.fail("sftp must not start"))
    for call in (
        lambda: runner.upload("box", source, "/srv/a", overwrite=False, cancel=cancel),
        lambda: runner.upload("box", source, "/srv/a", overwrite=True, cancel=cancel),
        lambda: runner.download("box", "/srv/a", tmp_path / "out", max_bytes=100, cancel=cancel),
    ):
        with pytest.raises(FileOperationError) as error:
            call()
        assert error.value.error_code == "canceled"


def test_meters_report_the_known_size_and_a_live_count(runner, source, tmp_path, monkeypatch):
    destination = tmp_path / "download"
    seen = []
    monkeypatch.setattr(runner, "stat_file", lambda *_a, **_o: metadata(size=40))

    def get(*_args, **_options):
        destination.write_bytes(b"x" * 25)
        seen.append(("during", measure()))
        destination.write_bytes(b"x" * 40)
        return 0, "", ""

    def meter(total, count):
        nonlocal measure
        seen.append(("total", total))
        measure = count
        seen.append(("before", count()))

    measure = None
    monkeypatch.setattr(runner, "_run_transfer", get)
    runner.download("box", "/srv/a", destination, max_bytes=100, cancel=threading.Event(), meter=meter)
    assert seen == [("total", 40), ("before", 0), ("during", 25)]

    started = {}

    def put(*_args, on_start=None, **_options):
        on_start(type("Process", (), {"pid": 4242})())
        return 0, "", ""

    monkeypatch.setattr(runner, "stat_file", missing)
    monkeypatch.setattr(runner, "_run_transfer", put)
    monkeypatch.setattr("ssh_server_manager.ssh_runner.read_position", lambda pid, path: started.setdefault("asked", (pid, path)) and 7)
    runner.upload("box", source, "/srv/a", overwrite=False, cancel=threading.Event(),
                  meter=lambda total, count: started.update(total=total, count=count()))
    assert started == {"asked": (4242, source), "total": len(b"new contents"), "count": 7}


def test_run_transfer_stops_a_real_process_and_reports_canceled(runner, monkeypatch):
    # Stand in a slow program for sftp; everything else is the production path.
    monkeypatch.setattr(runner, "_sftp_command", lambda *_a, **_o: [sys.executable, "-I", "-c", "import time; time.sleep(60)", "--", "host"])
    server = runner.database.get_server("box")
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    began = time.monotonic()
    with pytest.raises(FileOperationError) as error:
        runner._run_transfer(server, batch="get a b\n", timeout=60, reuse=0, stream=False, cancel=cancel)
    assert error.value.error_code == "canceled"
    assert time.monotonic() - began < 5

from __future__ import annotations

import os
import stat

from ssh_server_manager.operations import OperationContext
from ssh_server_manager.request_config import RequestConfigs


def test_request_snapshot_overrides_helper_multiplexing_without_editing_the_source(tmp_path, monkeypatch):
    monkeypatch.setenv("SSM_RUNTIME_DIR", str(tmp_path / "runtime"))
    source = tmp_path / "managed.conf"
    content = "Host box\n HostName example.invalid\nHost *\n ControlMaster auto\n ControlPersist 300\n"
    source.write_text(content)
    operation = OperationContext("host", 3)
    snapshots = RequestConfigs()
    path = snapshots.acquire(operation, source)
    assert path.read_text().startswith("# Hoploom request-owned process policy\nHost *\n  ControlMaster no\n")
    assert path.read_text().endswith(content)
    assert source.read_text() == content
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert snapshots.acquire(operation, source) == path
    operation.finish()
    assert not path.exists()


def test_shared_master_retains_its_startup_config_after_the_first_consumer_leaves(tmp_path, monkeypatch):
    monkeypatch.setenv("SSM_RUNTIME_DIR", str(tmp_path / "runtime"))
    source = tmp_path / "managed.conf"; source.write_text("Host box\n HostName example.invalid\n")
    snapshots = RequestConfigs()
    operation = OperationContext("host", 3)
    path = snapshots.acquire(operation, source)
    release = snapshots.hold(path)
    operation.cancel(); operation.finish()
    assert path.exists()
    release(); release()
    assert not path.exists()

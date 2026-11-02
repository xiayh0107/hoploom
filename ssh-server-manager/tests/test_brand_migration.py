from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ssh_server_manager import __version__
from ssh_server_manager.cli import skill_link_status
from ssh_server_manager.db import Database
from ssh_server_manager.service import SkillService
from ssh_server_manager.validation import ValidationError


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_links", ROOT / "scripts" / "install-links.py")
install_links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install_links)


def test_both_cli_names_share_inventory_json_errors_and_exit_codes(tmp_path):
    isolated = {**os.environ, "SSM_DATA_DIR": str(tmp_path / "data"),
                "SSM_RUNTIME_DIR": str(tmp_path / "runtime"),
                "SSM_MANAGED_SSH_CONFIG": str(tmp_path / "managed.conf"),
                "SSM_ORIGINAL_SSH_CONFIG": str(tmp_path / "original.conf")}

    def run(name, *arguments):
        return subprocess.run([sys.executable, str(ROOT / "scripts" / f"{name}.py"), *arguments],
                              cwd=tmp_path, env=isolated, text=True, capture_output=True, timeout=20)

    added = run("serverctl", "server", "add", "fixture", "--hostname", "example.invalid", "--username", "fixture", "--json")
    assert added.returncode == 0
    current = run("hoploom", "server", "list", "--json")
    legacy = run("serverctl", "server", "list", "--json")
    assert current.returncode == legacy.returncode == 0
    assert current.stdout == legacy.stdout
    assert not current.stderr and not legacy.stderr
    assert json.loads(current.stdout)[0]["alias"] == "fixture"
    for name in ("hoploom", "serverctl"):
        version = run(name, "--version")
        assert version.stdout.strip() == f"{name} {__version__}"
        assert run(name, "--help").stdout.startswith(f"usage: {name}")
    current = run("hoploom", "server", "show", "missing", "--json")
    legacy = run("serverctl", "server", "show", "missing", "--json")
    assert current.returncode == legacy.returncode == 2
    assert current.stdout == legacy.stdout


@pytest.mark.parametrize("name", ["hoploom", "ssh-server-manager", "Hoploom", "SSH-Server-Manager"])
def test_both_base_skill_names_are_excluded_from_host_bindings(tmp_path, name):
    source = tmp_path / "skills" / "base"
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(f"---\nname: {name}\ndescription: Base transport.\n---\n")
    service = SkillService(Database(tmp_path / "manager.db"))
    with pytest.raises(ValidationError, match="base transport"):
        service.register(source)
    assert service.discover([source.parent])["candidates"] == []


def test_new_skill_links_are_reported_without_losing_legacy_detection(tmp_path):
    for name in ("hoploom", "ssh-server-manager"):
        marker = tmp_path / name / "scripts" / "ssh_server_manager" / "__init__.py"
        marker.parent.mkdir(parents=True)
        marker.write_text(f'__version__ = "{__version__}"\n')
    assert skill_link_status([tmp_path]) == {"ok": True, "linked": 2}


def test_installer_creates_missing_command_directory_and_preserves_unrelated_file(tmp_path):
    source = tmp_path / "source"
    binary_directory = tmp_path / "missing" / "bin"
    (source / "scripts").mkdir(parents=True)
    suffix = ".cmd" if os.name == "nt" else ""
    for name in ("hoploom", "serverctl"):
        (source / "scripts" / (name + suffix)).write_text("fixture launcher")
    install_links.command_links(source, binary_directory)
    assert (binary_directory / ("hoploom" + suffix)).exists()
    assert (binary_directory / ("serverctl" + suffix)).exists()
    install_links.command_links(source, binary_directory)
    target = binary_directory / ("hoploom" + suffix)
    target.unlink()
    target.write_text("unrelated launcher")
    install_links.command_links(source, binary_directory)
    assert target.read_text() == "unrelated launcher"


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink migration; Windows uses junctions")
def test_skill_migration_removes_only_owned_legacy_links_and_deduplicates(tmp_path):
    source = tmp_path / "source"
    marker = source / "scripts" / "ssh_server_manager" / "__init__.py"
    marker.parent.mkdir(parents=True)
    marker.write_text(f'__version__ = "{__version__}"\n')
    skills = tmp_path / "agent" / "skills"
    skills.mkdir(parents=True)
    legacy = skills / "ssh-server-manager"
    legacy.symlink_to(source, target_is_directory=True)
    (skills / "hoploom").symlink_to(source, target_is_directory=True)
    assert skill_link_status([skills]) == {"ok": True, "linked": 1}
    install_links.skill_link(source, skills)
    assert (skills / "hoploom").resolve() == source
    assert not legacy.is_symlink()
    other = tmp_path / "other"
    other.mkdir()
    legacy.symlink_to(other, target_is_directory=True)
    install_links.skill_link(source, skills)
    assert legacy.resolve() == other


def test_installer_does_not_replace_real_skill_directories(tmp_path):
    skills = tmp_path / "agent" / "skills"
    (skills / "hoploom").mkdir(parents=True)
    manifest = skills / "hoploom" / "SKILL.md"
    manifest.write_text("user-owned instructions")
    install_links.skill_link(tmp_path / "source", skills)
    assert manifest.read_text() == "user-owned instructions"

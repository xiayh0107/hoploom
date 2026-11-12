from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import zipfile

import pytest

from ssh_server_manager import __version__

ROOT = Path(__file__).resolve().parents[1]


def script(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'scripts' / name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cargo_python_and_locked_native_versions_agree():
    cargo = (ROOT / 'Cargo.toml').read_text()
    assert re.search(r'^version = "([^"]+)"', cargo, re.M)[1] == __version__
    assert f'name = "hoploom-native"\nversion = "{__version__}"' in (ROOT / 'Cargo.lock').read_text()
    assert re.search(r'^version = "([^"]+)"', (ROOT / 'pyproject.toml').read_text(), re.M)[1] == __version__


def test_source_bootstrap_fails_before_creating_an_environment_without_rust(monkeypatch, capsys):
    bootstrap = script('bootstrap.py')
    monkeypatch.setattr(sys, 'argv', ['bootstrap.py'])
    monkeypatch.setattr(bootstrap.shutil, 'which', lambda name: None)
    monkeypatch.setattr(bootstrap.venv, 'EnvBuilder', lambda **kw: pytest.fail('must check Rust first'))
    assert bootstrap.main() == 1
    assert 'requires Rust' in capsys.readouterr().err


def test_wheel_bootstrap_needs_no_rust_and_checks_the_native_version(monkeypatch, tmp_path):
    bootstrap = script('bootstrap.py')
    marker = tmp_path / 'scripts/ssh_server_manager/__init__.py'
    marker.parent.mkdir(parents=True)
    marker.write_text(f'__version__ = "{__version__}"')
    (tmp_path / '.venv').mkdir()
    monkeypatch.setattr(bootstrap, '__file__', str(tmp_path / 'scripts/bootstrap.py'))
    monkeypatch.setattr(sys, 'argv', ['bootstrap.py', '--wheel', __version__])
    monkeypatch.setattr(bootstrap.shutil, 'which', lambda name: None)
    calls = []
    def run(args, **kw):
        calls.append(args)
        return SimpleNamespace(returncode=1 if args[-1] == 'ssh-server-manager' else 0)
    monkeypatch.setattr(bootstrap.subprocess, 'run', run)
    assert bootstrap.main() == 0
    assert any('--only-binary=:all:' in args and f'hoploom=={__version__}' in args for args in calls)
    assert '-I' in calls[-1] and calls[-1][-1] == __version__
    assert not any('-e' in args for args in calls)


def make_wheel(directory, platform, *, metadata_platform=None):
    info = f'hoploom-{__version__}.dist-info'
    path = directory / f'hoploom-{__version__}-cp310-abi3-{platform}.whl'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('ssh_server_manager/__init__.py', f'__version__ = "{__version__}"')
        archive.writestr('ssh_server_manager/_native.abi3.so', b'synthetic-native')
        archive.writestr('ssh_server_manager/assets/ui/index.html', '<html></html>')
        archive.writestr(info + '/METADATA', f'Name: hoploom\nVersion: {__version__}\n')
        tags = '\n'.join('Tag: cp310-abi3-' + item for item in (metadata_platform or platform).split('.'))
        archive.writestr(info + '/WHEEL', 'Root-Is-Purelib: false\n' + tags + '\n')
    return path


def test_release_gate_requires_all_eight_native_targets_and_consistent_tags(tmp_path):
    checker = script('wheel-manifest.py')
    platforms = ['macosx_10_12_x86_64', 'macosx_11_0_arm64', 'win_amd64', 'win_arm64',
                 'manylinux2014_x86_64.manylinux_2_17_x86_64', 'manylinux_2_17_aarch64',
                 'musllinux_1_2_x86_64', 'musllinux_1_2_aarch64']
    first = make_wheel(tmp_path, platforms[0])
    assert checker.manifest(tmp_path, __version__, 'a' * 40, complete=False)['complete'] is False
    with pytest.raises(ValueError, match='Incomplete'):
        checker.manifest(tmp_path, __version__, 'a' * 40, complete=True)
    for platform in platforms[1:]:
        make_wheel(tmp_path, platform)
    manifest = checker.manifest(tmp_path, __version__, 'a' * 40, complete=True)
    assert {wheel['target'] for wheel in manifest['wheels']} == checker.TARGETS
    make_wheel(tmp_path, platforms[0], metadata_platform='win_amd64')
    with pytest.raises(ValueError, match='metadata mismatch'):
        checker.wheel_record(first, __version__)

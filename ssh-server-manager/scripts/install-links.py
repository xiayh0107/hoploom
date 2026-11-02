#!/usr/bin/env python3
"""Install Hoploom's local entry points without replacing unrelated files."""
from __future__ import annotations

import os
import shlex
import stat
import subprocess
from pathlib import Path


SKILL_NAME = "hoploom"
LEGACY_SKILL_NAME = "ssh-server-manager"


def is_link(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", None) == getattr(
        stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003
    )


def remove_link(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
    else:
        # Windows directory junctions must be removed without traversing them.
        path.rmdir()


def skill_link(source: Path, directory: Path) -> None:
    if not directory.parent.is_dir():
        return
    directory.mkdir(exist_ok=True)
    target = directory / SKILL_NAME
    if target.exists() or is_link(target):
        if not is_link(target) or target.resolve() != source:
            print(f"skip: {target} is not a link to this installation")
            return
    elif os.name == "nt":
        # Paths travel as environment values, never interpolated PowerShell.
        subprocess.run([
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; $null = New-Item -ItemType Junction "
            "-Path $env:HOPLOOM_LINK_TARGET -Value $env:HOPLOOM_LINK_SOURCE",
        ], env={**os.environ, "HOPLOOM_LINK_TARGET": str(target),
                "HOPLOOM_LINK_SOURCE": str(source)}, check=True)
    else:
        target.symlink_to(source, target_is_directory=True)
    print(f"Skill linked: {target}")
    legacy = directory / LEGACY_SKILL_NAME
    if is_link(legacy) and legacy.resolve() == source:
        remove_link(legacy)
        print(f"Migrated old Skill link: {legacy}")


def command_links(source: Path, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("hoploom", "serverctl"):
        suffix = ".cmd" if os.name == "nt" else ""
        target = directory / (name + suffix)
        launcher = source / "scripts" / (name + suffix)
        if os.name == "nt":
            # cmd expands percent signs even inside quoted paths.
            content = '@echo off\n@"' + str(launcher).replace('%', '%%') + '" %*\n'
            if target.exists() or is_link(target):
                if is_link(target) or not target.is_file() or target.read_text() != content:
                    print(f"skip: {target} is not a launcher owned by this installation")
                    continue
            else:
                target.write_text(content)
        elif target.exists() or is_link(target):
            if not target.is_symlink() or target.resolve() != launcher:
                print(f"skip: {target} is not a link to this installation")
                continue
        else:
            target.symlink_to(launcher)
        print(f"Command linked: {name} -> {target}")
    path_entries = [os.path.normcase(str(Path(value).expanduser().resolve()))
                    for value in os.environ.get("PATH", "").split(os.pathsep) if value]
    if os.path.normcase(str(directory.resolve())) not in path_entries:
        launcher = source / "scripts" / ("hoploom.cmd" if os.name == "nt" else "hoploom")
        print(f"Add {directory} to PATH; until then use {launcher} directly.")


def main() -> None:
    source = Path(__file__).resolve().parents[1]
    home_directory = Path.home()
    directories = [home_directory / ".claude" / "skills", home_directory / ".codex" / "skills"]
    extra = os.environ.get("SSM_SKILLS_DIRS", "")
    directories.extend(Path(value).expanduser() for value in (
        extra.split(";") if os.name == "nt" else shlex.split(extra)
    ) if value)
    for directory in dict.fromkeys(directories):
        skill_link(source, directory)
    binary_directory = (Path(os.environ["LOCALAPPDATA"]) / "hoploom" / "bin"
                        if os.name == "nt" else home_directory / ".local" / "bin")
    command_links(source, binary_directory)


if __name__ == "__main__":
    main()

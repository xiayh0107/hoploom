#!/usr/bin/env python3
"""Validate native wheels and describe the complete release platform set."""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

TARGETS = {"macos-x64", "macos-arm64", "windows-x64", "windows-arm64",
           "glibc-x64", "glibc-arm64", "musl-x64", "musl-arm64"}
WHEEL = re.compile(r"^hoploom-(\d+\.\d+\.\d+)-(?P<python>cp310)-(?P<abi>abi3)-(?P<platform>[a-z0-9_.]+)\.whl$")


def target_of(platform: str) -> str:
    if re.fullmatch(r"macosx_\d+_\d+_(x86_64|arm64)", platform):
        return "macos-" + ("x64" if platform.endswith("x86_64") else "arm64")
    if platform in {"win_amd64", "win_arm64"}:
        return "windows-" + ("x64" if platform == "win_amd64" else "arm64")
    match = re.fullmatch(r"(manylinux(?:2014|_\d+_\d+)|musllinux_\d+_\d+)_(x86_64|aarch64)", platform)
    if match:
        return ("glibc-" if platform.startswith("manylinux") else "musl-") + ("x64" if match[2] == "x86_64" else "arm64")
    raise ValueError(f"Unsupported release wheel platform: {platform}")


def wheel_record(path: Path, version: str) -> dict:
    match = WHEEL.fullmatch(path.name)
    if not match or match[1] != version:
        raise ValueError(f"Wrong version or ABI in {path.name}")
    platforms = match["platform"].split(".")
    targets = {target_of(platform) for platform in platforms}
    if len(targets) != 1:
        raise ValueError(f"Ambiguous platform wheel: {path.name}")
    info = f"hoploom-{version}.dist-info"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(
            PurePosixPath(name).is_absolute() or "\\" in name or ".." in PurePosixPath(name).parts
            or not name.startswith(("ssh_server_manager/", info + "/"))
            or "/__pycache__/" in name or name.endswith((".pyc", ".db", ".pem", ".key")) for name in names
        ):
            raise ValueError(f"Unexpected wheel member in {path.name}")
        native = [name for name in names if name.startswith("ssh_server_manager/_native") and name.endswith((".so", ".pyd"))]
        if len(native) != 1 or "ssh_server_manager/assets/ui/index.html" not in names:
            raise ValueError(f"Missing native module or built UI in {path.name}")
        metadata = BytesParser().parsebytes(archive.read(info + "/METADATA"))
        wheel = BytesParser().parsebytes(archive.read(info + "/WHEEL"))
        declared = set(wheel.get_all("Tag", []))
        expected = {f"cp310-abi3-{platform}" for platform in platforms}
        if metadata["Name"] != "hoploom" or metadata["Version"] != version or declared != expected or wheel["Root-Is-Purelib"] != "false":
            raise ValueError(f"Wheel metadata mismatch in {path.name}")
        init = archive.read("ssh_server_manager/__init__.py").decode()
        if not re.search(r'__version__\s*=\s*"' + re.escape(version) + '"', init):
            raise ValueError(f"Python version mismatch in {path.name}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return {"filename": path.name, "python": "cp310", "abi": "abi3", "platforms": platforms,
            "target": targets.pop(), "sha256": digest.hexdigest()}


def manifest(directory: Path, version: str, commit: str, *, complete: bool) -> dict:
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("Expected the full source commit SHA")
    records = [wheel_record(path, version) for path in sorted(directory.glob("*.whl"))]
    targets = [record["target"] for record in records]
    if not records or len(targets) != len(set(targets)):
        raise ValueError("Missing wheels or duplicate release target")
    if complete and set(targets) != TARGETS:
        raise ValueError("Incomplete release wheel set; missing: " + ", ".join(sorted(TARGETS - set(targets))))
    return {"schema": 2, "version": version, "sourceCommit": commit, "complete": complete, "wheels": records}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--development", action="store_true", help="allow one local target; never publish this set")
    args = parser.parse_args()
    value = manifest(args.directory, args.version, args.commit, complete=not args.development)
    (args.directory / "manifest.json").write_text(json.dumps(value, indent=2) + "\n")
    print(f"Validated {len(value['wheels'])} native wheels for {args.version} ({'development' if args.development else 'complete release'})")

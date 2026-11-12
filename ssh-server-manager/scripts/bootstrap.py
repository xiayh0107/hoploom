#!/usr/bin/env python3
from __future__ import annotations

import os
import argparse
import re
import subprocess
import shutil
import sys
import venv
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare the source checkout or its matching published wheel")
    parser.add_argument("--wheel", metavar="VERSION", help="install this exact published native wheel; never build from source")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.wheel:
        declared = re.search(r'__version__\s*=\s*"([^"]+)"', (root / "scripts/ssh_server_manager/__init__.py").read_text())[1]
        if not re.fullmatch(r"\d+\.\d+\.\d+", args.wheel) or args.wheel != declared:
            parser.error("the published wheel version must match this Skill checkout")
    elif not shutil.which("cargo") or not shutil.which("rustc"):
        print("Building this source checkout requires Rust. Install the pinned toolchain from rust-toolchain.toml, "
              "or install the published Hoploom wheel without a Rust compiler.", file=sys.stderr)
        return 1
    environment = root / ".venv"
    if not environment.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    # The renamed distribution owns the same Python modules. Remove the old
    # distribution's metadata/files first, inside this checkout's venv only.
    legacy = subprocess.run([str(python), "-m", "pip", "show", "ssh-server-manager"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if legacy.returncode == 0:
        subprocess.run([str(python), "-m", "pip", "uninstall", "-y", "ssh-server-manager"], check=True)
    if args.wheel:
        subprocess.run([str(python), "-m", "pip", "install", "--only-binary=:all:", f"hoploom=={args.wheel}"], check=True)
        subprocess.run([str(python), "-I", "-c", "import sys; from ssh_server_manager import __version__, _native; "
                        "assert __version__ == _native.version == sys.argv[1]", args.wheel], check=True)
    else:
        subprocess.run([str(python), "-m", "pip", "install", "-e", f"{root}[test]"], check=True)
    print(f"Ready: {python}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


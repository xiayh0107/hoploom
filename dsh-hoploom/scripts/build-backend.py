"""Bundle release wheels from this commit, or explicitly build a local dev wheel.

HOPLOOM_WHEEL_DIR points at the verified native-dist workflow artifact. A local
build is intentionally marked incomplete and cannot pass the npm prepack gate.
"""
from pathlib import Path
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

plugin = Path(__file__).resolve().parents[1]
repo = plugin.parent
source = repo / 'ssh-server-manager'
version = re.search(r'^version = "([^"]+)"', (source / 'pyproject.toml').read_text(), re.M)[1]
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
spec = importlib.util.spec_from_file_location('wheel_manifest', source / 'scripts/wheel-manifest.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
destination = plugin / 'backend'
destination.mkdir(exist_ok=True)


def bundle(directory, complete):
    manifest = checker.manifest(directory, version, commit, complete=complete)
    if complete:
        origin = json.loads((directory / 'manifest.json').read_text())
        if origin != manifest:
            raise SystemExit('Release wheel manifest does not match this source commit and its artifacts')
    # Validate everything before changing the existing bundle.
    for previous in destination.glob('*.whl'):
        previous.unlink()
    for record in manifest['wheels']:
        shutil.copyfile(directory / record['filename'], destination / record['filename'])
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Bundled {len(manifest['wheels'])} native wheel(s); complete={complete}", file=sys.stderr)


if directory := os.environ.get('HOPLOOM_WHEEL_DIR'):
    bundle(Path(directory).resolve(), True)
else:
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'ssh-server-manager'], cwd=repo).decode().split('\0')
    with tempfile.TemporaryDirectory(prefix='hoploom-plugin-wheel-') as temporary:
        stage = Path(temporary) / 'source'
        stage.mkdir()
        for relative in filter(None, tracked):
            path = Path(relative).relative_to('ssh-server-manager')
            public = path.as_posix()
            if public not in {'pyproject.toml', 'README.md', 'LICENSE', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'} and not public.startswith(('scripts/ssh_server_manager/', 'rust/src/')):
                continue
            target = stage / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / path, target)
        output = Path(temporary) / 'wheel'
        env = dict(os.environ, SOURCE_DATE_EPOCH='315532800', CARGO_TARGET_DIR=str(source / 'target'))
        subprocess.run([sys.executable, '-m', 'build', '--wheel', '--outdir', str(output), str(stage)], env=env, check=True, stdout=subprocess.DEVNULL)
        bundle(output, False)

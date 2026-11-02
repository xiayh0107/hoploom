"""Bundle a wheel built only from tracked public backend source files."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

plugin = Path(__file__).resolve().parents[1]
repo = plugin.parent
source = repo / 'ssh-server-manager'
tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'ssh-server-manager'], cwd=repo).decode().split('\0')
with tempfile.TemporaryDirectory(prefix='hoploom-plugin-wheel-') as temporary:
    stage = Path(temporary) / 'source'
    stage.mkdir()
    for relative in filter(None, tracked):
        path = Path(relative).relative_to('ssh-server-manager')
        if path.as_posix() not in {'pyproject.toml', 'README.md', 'LICENSE'} and not path.as_posix().startswith('scripts/ssh_server_manager/'):
            continue
        target = stage / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / path, target)
    output = Path(temporary) / 'wheel'
    env = dict(os.environ, SOURCE_DATE_EPOCH='315532800')
    subprocess.run([sys.executable, '-m', 'build', '--wheel', '--outdir', str(output), str(stage)], env=env, check=True, stdout=subprocess.DEVNULL)
    wheel, = output.glob('hoploom-*-py3-none-any.whl')
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert all(name.startswith(('ssh_server_manager/', 'hoploom-')) for name in names)
        assert any(name.endswith('assets/ui/index.html') for name in names)
        assert not any('/__pycache__/' in name or name.endswith(('.db', '.pem', '.key')) for name in names)
    destination = plugin / 'backend'
    destination.mkdir(exist_ok=True)
    for previous in destination.glob('*.whl'):
        previous.unlink()
    shutil.copyfile(wheel, destination / wheel.name)
    manifest = {'filename': wheel.name, 'version': wheel.name.split('-')[1], 'sha256': hashlib.sha256(wheel.read_bytes()).hexdigest()}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Bundled {wheel.name} ({wheel.stat().st_size} bytes)', file=sys.stderr)

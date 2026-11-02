import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./build-backend.py', import.meta.url))
const local = fileURLToPath(new URL(process.platform === 'win32'
  ? '../../ssh-server-manager/.venv/Scripts/python.exe'
  : '../../ssh-server-manager/.venv/bin/python', import.meta.url))
const python = process.env.HOPLOOM_BUILD_PYTHON || process.env.HOPLOOM_TEST_PYTHON
  || (existsSync(local) ? local : process.platform === 'win32' ? 'python' : 'python3')
execFileSync(python, [script], { stdio: 'inherit' })

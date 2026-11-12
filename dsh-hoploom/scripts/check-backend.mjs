import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { bundledWheel, readWheelManifest } from '../lib/wheels.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const value = await readWheelManifest()
if (!value.complete) throw new Error('npm publication requires all eight native wheel targets. Import native-dist with HOPLOOM_WHEEL_DIR and build:backend; prepack never rebuilds the bundle.')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
execFileSync('git', ['diff', '--exit-code', '--quiet', 'HEAD', '--', 'ssh-server-manager'], { cwd: repo })
const version = /^version = "([^"]+)"/m.exec(await readFile(new URL('../../ssh-server-manager/pyproject.toml', import.meta.url), 'utf8'))?.[1]
if (value.sourceCommit !== commit || value.version !== version) throw new Error('Native wheels must be built from the same clean commit and backend version as this plugin')
for (const wheel of value.wheels) await bundledWheel([`${wheel.python}-${wheel.abi}-${wheel.platforms[0]}`])
console.log('Verified the complete native wheel collection and source commit')

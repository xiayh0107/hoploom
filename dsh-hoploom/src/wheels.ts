import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLocal } from './process.js'
import { SetupError } from './state.js'

export const wheelDirectory = fileURLToPath(new URL('../backend/', import.meta.url))
const tagsScript = fileURLToPath(new URL('../python/wheel_tags.py', import.meta.url))
const targets = new Set(['macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64',
  'glibc-x64', 'glibc-arm64', 'musl-x64', 'musl-arm64'])
export interface WheelRecord {
  filename: string; sha256: string; python: 'cp310'; abi: 'abi3'; platforms: string[]; target: string
}
export interface WheelManifest {
  schema: 2; version: string; sourceCommit: string; complete: boolean; wheels: WheelRecord[]
}

function targetOf(platform: string): string | undefined {
  if (/^macosx_\d+_\d+_(x86_64|arm64)$/.test(platform)) return `macos-${platform.endsWith('x86_64') ? 'x64' : 'arm64'}`
  if (/^win_(amd64|arm64)$/.test(platform)) return `windows-${platform.endsWith('amd64') ? 'x64' : 'arm64'}`
  if (/^(manylinux(2014|_\d+_\d+)|musllinux_\d+_\d+)_(x86_64|aarch64)$/.test(platform)) {
    return `${platform.startsWith('manylinux') ? 'glibc' : 'musl'}-${platform.endsWith('x86_64') ? 'x64' : 'arm64'}`
  }
}

export async function readWheelManifest(directory = wheelDirectory): Promise<WheelManifest> {
  try {
    const value: WheelManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    if (value.schema !== 2 || !/^\d+\.\d+\.\d+$/.test(value.version) || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
      || typeof value.complete !== 'boolean' || !Array.isArray(value.wheels) || !value.wheels.length || value.wheels.length > 8) throw 0
    const seen = new Set<string>()
    for (const wheel of value.wheels) {
      if (wheel.python !== 'cp310' || wheel.abi !== 'abi3' || !Array.isArray(wheel.platforms) || !wheel.platforms.length
        || !/^[a-f0-9]{64}$/.test(wheel.sha256) || !targets.has(wheel.target) || seen.has(wheel.target)
        || wheel.platforms.some(platform => typeof platform !== 'string' || targetOf(platform) !== wheel.target)
        || wheel.filename !== `hoploom-${value.version}-cp310-abi3-${wheel.platforms.join('.')}.whl`) throw 0
      seen.add(wheel.target)
    }
    if (value.complete && seen.size !== targets.size) throw 0
    return value
  } catch { throw new SetupError('integrity') }
}

/** Only the Python that will load the extension supplies compatibility tags. */
export async function pythonTags(command: string, signal: AbortSignal): Promise<string[]> {
  const result = await runLocal(command, ['-I', tagsScript], { signal, timeoutMs: 10000, capture: true })
  try {
    const value = JSON.parse(result.stdout)
    if (result.code || !Array.isArray(value.tags) || !value.tags.length
      || value.tags.some((tag: unknown) => typeof tag !== 'string' || !/^cp310-abi3-[a-z0-9_]+$/.test(tag as string))) throw 0
    return value.tags
  } catch { throw new SetupError('unsupported') }
}

export async function bundledWheel(tags: string[], directory = wheelDirectory): Promise<{
  path: string; manifest: WheelRecord & { version: string; sourceCommit: string }
}> {
  const collection = await readWheelManifest(directory)
  let selected: WheelRecord | undefined
  for (const tag of tags) {
    selected = collection.wheels.find(wheel => wheel.platforms.some(platform => tag === `${wheel.python}-${wheel.abi}-${platform}`))
    if (selected) break
  }
  if (!selected) throw new SetupError('unsupported')
  const path = join(directory, selected.filename)
  try {
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== selected.sha256) throw 0
  } catch { throw new SetupError('integrity') }
  return { path, manifest: { ...selected, version: collection.version, sourceCommit: collection.sourceCommit } }
}

/** Import and version evidence only; the Tokio runtime remains uninitialized. */
export async function verifyNative(command: string, version: string, signal: AbortSignal): Promise<void> {
  const result = await runLocal(command, ['-I', '-c',
    'import sys; from ssh_server_manager import __version__, _native; '
    + 'assert __version__ == _native.version == sys.argv[1]; assert _native.worker_threads == 2', version], { signal, timeoutMs: 10000 })
  if (result.code) throw new SetupError('backend')
}

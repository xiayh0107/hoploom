import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { extractUv } from './archive.js'
import { runLocal } from './process.js'
import { SetupError, type Stage } from './state.js'
import { UV_VERSION, uvAssets } from './uv-assets.js'

export interface BackendLaunch { command: string; commandArgs: string[] }
interface WheelManifest { filename: string; version: string; sha256: string }
const wheelDirectory = fileURLToPath(new URL('../backend/', import.meta.url))
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

export function managedDirectory(override = ''): string {
  if (override) {
    if (!isAbsolute(override) || override.includes('\0')) throw new SetupError('storage')
    return override
  }
  const dshHome = process.env.DSH_HOME
  return join(dshHome && isAbsolute(dshHome) ? dshHome : join(homedir(), '.dsh'), 'plugin-data', 'hoploom')
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

/** One installer per managed directory, including across dsh processes. */
export async function installationLock(root: string, signal: AbortSignal, waiting: () => void): Promise<() => Promise<void>> {
  const lock = join(root, 'install.lock')
  const id = randomUUID()
  const ownerFile = join(lock, `owner-${id}.json`)
  const deadline = Date.now() + 600000
  while (true) {
    signal.throwIfAborted()
    if (Date.now() > deadline) throw new SetupError('timeout')
    try {
      await mkdir(lock, { mode: 0o700 })
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, id }), { mode: 0o600, flag: 'wx' })
      if ((await readdir(lock)).some(name => name !== `owner-${id}.json`)) {
        await unlink(ownerFile)
        continue
      }
      return async () => {
        await unlink(ownerFile).catch(() => {})
        await rmdir(lock).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new SetupError('storage')
    }
    try {
      const entries = await readdir(lock)
      const observed = entries.find(name => /^owner-[a-f0-9-]{36}\.json$/.test(name))
      if (!observed) {
        if (!entries.length && Date.now() - (await stat(lock)).mtimeMs > 60000) await rmdir(lock)
        waiting()
        await delay(250, undefined, { signal })
        continue
      }
      const observedFile = join(lock, observed)
      let owner: { pid?: number; id?: string }
      try { owner = JSON.parse(await readFile(observedFile, 'utf8')) }
      catch (error) {
        // A process can die after creating its marker but before writing JSON.
        if (error instanceof SyntaxError && Date.now() - (await stat(observedFile)).mtimeMs > 60000) {
          await unlink(observedFile)
          await rmdir(lock).catch(() => {})
          continue
        }
        throw error
      }
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.id === 'string') {
        try { process.kill(owner.pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Remove only the unique owner we observed, then only an empty
            // directory. Competing stale-lock cleaners cannot erase a new owner.
            await unlink(observedFile)
            await rmdir(lock).catch(() => {})
            continue
          }
        }
      }
    } catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
    }
    waiting()
    await delay(250, undefined, { signal })
  }
}

export async function downloadVerified(url: string, sha256: string, signal: AbortSignal): Promise<Buffer> {
  let response: Response
  try { response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]) }) }
  catch { signal.throwIfAborted(); throw new SetupError('download') }
  if (!response.ok || !response.body || new URL(response.url || url).protocol !== 'https:') {
    await response.body?.cancel()
    throw new SetupError('download')
  }
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 64 * 1024 * 1024) throw new SetupError('integrity')
      chunks.push(Buffer.from(part.value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    signal.throwIfAborted()
    throw error instanceof SetupError ? error : new SetupError('download')
  } finally { reader.releaseLock() }
  const archive = Buffer.concat(chunks)
  if (hash(archive) !== sha256) throw new SetupError('integrity')
  return archive
}

async function uvExecutable(root: string, signal: AbortSignal, progress: (stage: Stage) => void): Promise<string> {
  const asset = uvAssets[`${process.platform}-${process.arch}`]
  if (!asset) throw new SetupError('unsupported')
  const executable = join(root, `uv-${UV_VERSION}${process.platform === 'win32' ? '.exe' : ''}`)
  try {
    const record = JSON.parse(await readFile(executable + '.json', 'utf8'))
    if (record.archive === asset.sha256 && record.binary === hash(await readFile(executable))) return executable
  } catch { /* no complete verified copy yet */ }
  progress('downloading')
  const archive = await downloadVerified(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.filename}`, asset.sha256, signal)
  const binary = extractUv(archive, asset.filename)
  const temporary = executable + `.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, binary, { mode: 0o700, flag: 'wx' })
    await rename(temporary, executable)
    await chmod(executable, 0o700)
    await atomicJson(executable + '.json', { archive: asset.sha256, binary: hash(binary) })
  } finally { await rm(temporary, { force: true }) }
  return executable
}

export async function bundledWheel(directory = wheelDirectory): Promise<{ path: string; manifest: WheelManifest }> {
  let manifest: WheelManifest
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) }
  catch { throw new SetupError('integrity') }
  if (!/^hoploom-[0-9.]+-py3-none-any\.whl$/.test(manifest.filename) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new SetupError('integrity')
  }
  const path = join(directory, manifest.filename)
  if (hash(await readFile(path)) !== manifest.sha256) throw new SetupError('integrity')
  return { path, manifest }
}

function launchAt(root: string, directory: string): BackendLaunch {
  return {
    command: join(root, 'environments', directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    commandArgs: ['-m', 'ssh_server_manager.cli'],
  }
}

export async function prepareManagedBackend(options: {
  root: string
  signal: AbortSignal
  progress(stage: Stage): void
  verify(launch: BackendLaunch): Promise<void>
  wheelDir?: string
}): Promise<BackendLaunch> {
  const { root, signal, progress, verify } = options
  const wheel = await bundledWheel(options.wheelDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const cached = async (): Promise<BackendLaunch | undefined> => {
    try {
      const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
      if (current.sha256 !== wheel.manifest.sha256 || !/^env-[a-f0-9-]{36}$/.test(current.directory)) return
      const launch = launchAt(root, current.directory)
      await access(launch.command, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      await verify(launch)
      return launch
    } catch { signal.throwIfAborted(); return }
  }
  const previous = await cached()
  if (previous) return previous
  const release = await installationLock(root, signal, () => progress('waiting'))
  let created: string | undefined
  let committed = false
  try {
    const ready = await cached()
    if (ready) return ready
    const uv = await uvExecutable(root, signal, progress)
    const directory = `env-${randomUUID()}`
    created = join(root, 'environments', directory)
    await mkdir(join(root, 'environments'), { recursive: true, mode: 0o700 })
    const env = {
      UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_CACHE_DIR: join(root, 'cache'),
      UV_PYTHON_DOWNLOADS: 'automatic', UV_NO_PROGRESS: '1', UV_NO_CONFIG: '1',
    }
    progress('python')
    const venv = await runLocal(uv, ['venv', '--no-project', '--no-config', '--managed-python', '--python', '3.13', created], { env, cwd: root, signal })
    if (venv.code !== 0) throw new SetupError('install')
    const launch = launchAt(root, directory)
    progress('installing')
    const installed = await runLocal(uv, ['pip', 'install', '--no-config', '--python', launch.command,
      '--index-url', 'https://pypi.org/simple', wheel.path], { env, cwd: root, signal })
    if (installed.code !== 0) throw new SetupError('install')
    await verify(launch)
    signal.throwIfAborted()
    await atomicJson(join(root, 'current.json'), { version: wheel.manifest.version, sha256: wheel.manifest.sha256, directory })
    committed = true
    return launch
  } finally {
    // Only this attempt's new environment is disposable. Prior ready installs
    // can still serve other profiles and are never replaced or removed here.
    if (created && !committed) await rm(created, { recursive: true, force: true })
    await release()
  }
}

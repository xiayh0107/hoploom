import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import spawn from 'cross-spawn'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'

const recovery = 'Install or update Hoploom on the machine running dsh, set the plugin command to its absolute executable path, then re-enable the plugin. Guide: https://xiayh0107.github.io/hoploom/docs/dsh-plugin.html'

interface LookupOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  platform?: NodeJS.Platform
}

/** Resolve locally without sourcing a shell or searching the workspace. */
export async function resolveCommand(command: string, options: LookupOptions = {}): Promise<string> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const windows = platform === 'win32'
  const path = windows ? win32 : posix
  const envValue = (key: string) => env[Object.keys(env).find(name =>
    windows ? name.toUpperCase() === key : name === key) ?? key] ?? ''
  let candidates: string[]
  if (path.isAbsolute(command)) {
    candidates = [command]
  } else {
    if (command.includes('/') || (windows && command.includes('\\'))) {
      throw new Error(`dsh-hoploom: command must be a bare executable name or an absolute path. ${recovery}`)
    }
    // Ignore empty/relative PATH entries: a project file must not impersonate
    // an installed backend when a desktop app has a restricted PATH.
    const directories = envValue('PATH').split(path.delimiter).filter(directory => path.isAbsolute(directory))
    if (command === 'hoploom') {
      directories.push(path.join(home, '.local', 'bin'))
      if (windows && path.isAbsolute(envValue('LOCALAPPDATA'))) {
        directories.push(path.join(envValue('LOCALAPPDATA'), 'hoploom', 'bin'))
      } else if (!windows) {
        if (platform === 'darwin') directories.push('/opt/homebrew/bin')
        directories.push('/usr/local/bin')
      }
    }
    candidates = [...new Set(directories)].map(directory => path.join(directory, command))
  }
  const extensions = windows
    ? (envValue('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => /^\.[a-z0-9]+$/i.test(ext))
    : []
  for (const candidate of candidates) {
    const paths = windows && !path.extname(candidate)
      ? [...extensions.map(extension => candidate + extension), candidate]
      : [candidate]
    for (const filename of paths) {
      try {
        if (!(await stat(filename)).isFile()) continue
        await access(filename, windows ? constants.F_OK : constants.X_OK)
        return filename
      } catch {
        // Try only the next deterministic installation location.
      }
    }
  }
  throw new Error(`dsh-hoploom: Hoploom backend executable was not found. The npm plugin does not include the Python backend. ${recovery}`)
}

/** Argparse help exits before opening Hoploom's database, vault or SSH client. */
export async function checkBackend(bridge: StdioConfig, options: {
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<void> {
  const signal = options.signal
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(bridge.command, [...bridge.args, '--help'], {
      env: { ...scrubbedParentEnv(), ...bridge.env },
      stdio: 'ignore', windowsHide: true, shell: false,
    })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(new Error('dsh-hoploom: backend startup was cancelled.'))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`dsh-hoploom: Hoploom backend startup check timed out. ${recovery}`))
    }, options.timeoutMs ?? 10000)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', () => finish(new Error(`dsh-hoploom: the configured backend could not start. ${recovery}`)))
    child.once('close', code => finish(code === 0 ? undefined : new Error(
      `dsh-hoploom: the configured backend cannot run mcp serve --help. Older serverctl installations may lack MCP support. ${recovery}`,
    )))
    if (signal?.aborted) abort()
  })
}

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import spawn from 'cross-spawn'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { SetupError } from './state.js'

export interface LocalProcess {
  child: ChildProcess
  done: Promise<{ code: number | null; stdout: string }>
  stop(): Promise<void>
}

/** Own only this child's process group/tree; never inherit or publish stderr. */
export function startLocal(command: string, args: string[], options: {
  env?: Record<string, string>
  cwd?: string
  capture?: boolean
  signal?: AbortSignal
} = {}): LocalProcess {
  options.signal?.throwIfAborted()
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...scrubbedParentEnv(), ...options.env },
    stdio: ['ignore', options.capture ? 'pipe' : 'ignore', 'ignore'],
    windowsHide: true, shell: false, detached: process.platform !== 'win32',
  })
  let stdout = ''
  let closed = false
  let stopping: Promise<void> | undefined
  const done = new Promise<{ code: number | null; stdout: string }>((accept, reject) => {
    child.stdout?.on('data', (data: Buffer) => {
      // Status JSON is tiny; retain no output from installation or UI launch.
      if (Buffer.byteLength(stdout) + data.length <= 65536) stdout += data.toString('utf8')
      else { void stop(); reject(new Error('dsh-hoploom: subprocess output exceeded its limit.')) }
    })
    child.once('error', () => reject(new Error('dsh-hoploom: local process could not start.')))
    child.once('close', code => { closed = true; accept({ code, stdout }) })
  })
  // A background UI may exit while no request is awaiting it.
  void done.catch(() => {})
  async function stop(): Promise<void> {
    if (stopping) return stopping
    if (closed || !child.pid) return
    const pid = child.pid
    stopping = (async () => {
      if (process.platform === 'win32') {
        const taskkill = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
        await new Promise<void>(accept => {
          const killer = nodeSpawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore', windowsHide: true, env: scrubbedParentEnv(),
          })
          const timeout = setTimeout(() => { killer.kill(); child.kill(); accept() }, 5000)
          killer.once('error', () => { child.kill(); accept() })
          killer.once('close', () => { clearTimeout(timeout); accept() })
        })
      } else {
        try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
        const escalation = setTimeout(() => {
          try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
        }, 1000)
        await Promise.race([done.catch(() => {}), new Promise(accept => setTimeout(accept, 1100))])
        clearTimeout(escalation)
        // Descendants can outlive a cooperative parent during cancellation.
        try { process.kill(-pid, 'SIGKILL') } catch { /* group is empty */ }
      }
      await done.catch(() => {})
    })()
    return stopping
  }
  const abort = () => { void stop() }
  options.signal?.addEventListener('abort', abort, { once: true })
  void done.finally(() => options.signal?.removeEventListener('abort', abort)).catch(() => {})
  if (options.signal?.aborted) abort()
  return { child, done, stop }
}

export async function runLocal(command: string, args: string[], options: Parameters<typeof startLocal>[2] & {
  timeoutMs?: number
} = {}): Promise<{ code: number | null; stdout: string }> {
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new SetupError('timeout')), options.timeoutMs ?? 600000)
  let running: LocalProcess | undefined
  try {
    running = startLocal(command, args, { ...options, signal })
    const result = await running.done
    signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    if (signal.aborted) await running?.stop()
  }
}

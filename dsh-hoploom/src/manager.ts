import { setTimeout as delay } from 'node:timers/promises'
import open from 'open'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import { checkBackend, resolveCommand } from './backend.js'
import { bridgeConfig, type Config } from './config.js'
import { managedDirectory, prepareManagedBackend, type BackendLaunch } from './managed.js'
import { runLocal, startLocal, type LocalProcess } from './process.js'
import { activeStages, SetupError, type BackendState, type Stage } from './state.js'

export class BackendManager {
  private state: BackendState
  private active?: Promise<void>
  private controller?: AbortController
  private launch?: BackendLaunch
  private ui?: LocalProcess
  private opening?: Promise<void>
  private disconnect?: () => Promise<void>
  private disposed = false

  constructor(private config: Config, private connect: (bridge: StdioConfig) => Promise<() => Promise<void>>) {
    bridgeConfig(config)
    this.state = { stage: 'checking', source: null, error: null,
      remoteEnabled: config.allowRemote, execEnabled: config.allowExec }
  }

  snapshot(): BackendState { return { ...this.state } }

  private stage(stage: Stage): void {
    if (!this.disposed) this.state = { ...this.state, stage, error: null }
  }

  private bridge(launch: BackendLaunch): StdioConfig {
    return bridgeConfig({ ...this.config, ...launch })
  }

  start(installRequested = false): Promise<void> {
    if (this.disposed || this.state.stage === 'ready') return Promise.resolve()
    if (this.active) return this.active
    const controller = new AbortController()
    this.controller = controller
    this.stage('checking')
    this.active = this.prepare(controller.signal, installRequested).catch(error => {
      if (this.disposed) return
      this.state = { ...this.state, stage: controller.signal.aborted ? 'cancelled' : 'error',
        error: controller.signal.aborted ? null : error instanceof SetupError ? error.code
          : ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error?.code) ? 'storage' : 'backend' }
    }).finally(() => { this.active = undefined })
    return this.active
  }

  private async prepare(signal: AbortSignal, installRequested: boolean): Promise<void> {
    let launch: BackendLaunch | undefined
    const automatic = this.config.command === 'hoploom' && this.config.commandArgs.length === 0
    try {
      const command = await resolveCommand(this.config.command)
      launch = { command, commandArgs: this.config.commandArgs }
      await checkBackend(this.bridge(launch), { signal })
      this.state.source = 'existing'
    } catch {
      signal.throwIfAborted()
      launch = undefined
      if (!automatic) throw new SetupError('custom-command')
    }
    if (!launch) {
      if (!this.config.autoInstall && !installRequested) { this.stage('needs-install'); return }
      this.state.source = 'managed'
      launch = await prepareManagedBackend({
        root: managedDirectory(this.config.managedDir), signal,
        progress: stage => this.stage(stage),
        verify: launch => checkBackend(this.bridge(launch), { signal }),
      })
    }
    signal.throwIfAborted()
    this.stage('connecting')
    const disconnect = await this.connect(this.bridge(launch))
    if (signal.aborted || this.disposed) { await disconnect(); signal.throwIfAborted(); return }
    this.disconnect = disconnect
    this.launch = launch
    this.stage('ready')
  }

  async cancel(): Promise<void> {
    if (!activeStages.includes(this.state.stage)) return
    this.controller?.abort()
    await this.active
  }

  openManagement(): Promise<void> {
    if (this.opening) return this.opening
    this.opening = this.openUi().finally(() => { this.opening = undefined })
    return this.opening
  }

  private async openUi(): Promise<void> {
    if (!this.launch || this.state.stage !== 'ready' || this.disposed) throw new SetupError('backend')
    const launch = this.launch
    const signal = this.controller!.signal
    const status = async (): Promise<{ running?: boolean; port?: number }> => {
      const result = await runLocal(launch.command, [...launch.commandArgs, 'ui', '--status', '--json'], {
        env: this.bridge(launch).env, signal, capture: true, timeoutMs: 10000,
      })
      try { return JSON.parse(result.stdout) } catch { return {} }
    }
    const existing = await status()
    if (existing.running && Number.isInteger(existing.port) && existing.port! > 0 && existing.port! < 65536) {
      // Reuse the browser's existing session; no launch URL crosses the API.
      await open(`http://localhost:${existing.port}/`)
      return
    }
    const process = startLocal(launch.command, [...launch.commandArgs, 'ui'], {
      env: this.bridge(launch).env, signal,
    })
    this.ui = process
    let exited = false
    void process.done.finally(() => { exited = true; if (this.ui === process) this.ui = undefined }).catch(() => {})
    try {
      for (let attempt = 0; attempt < 25; attempt++) {
        if (exited) throw new SetupError('backend')
        if ((await status()).running) return
        await delay(200, undefined, { signal })
      }
      throw new SetupError('timeout')
    } catch (error) { await process.stop(); throw error }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    await this.active
    await this.opening?.catch(() => {})
    await this.ui?.stop()
    await this.disconnect?.()
  }
}

import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'
import { checkBackend, resolveCommand } from './backend.js'
import { bridgeConfig, type Config } from './config.js'
import { managedDirectory, prepareManagedBackend, type BackendLaunch } from './managed.js'
import { EmbeddedUi } from './embedded.js'
import { activeStages, SetupError, type BackendState, type Stage } from './state.js'

export class BackendManager {
  private state: BackendState
  private active?: Promise<void>
  private controller?: AbortController
  private ui?: EmbeddedUi
  private opening?: Promise<void>
  private uiController?: AbortController
  private disconnect?: () => Promise<void>
  private disposed = false

  constructor(private config: Config, private connect: (bridge: StdioConfig) => Promise<() => Promise<void>>) {
    bridgeConfig(config)
    this.state = { stage: 'checking', source: null, error: null,
      remoteEnabled: config.allowRemote, execEnabled: config.allowExec, uiStage: null, uiError: null }
  }

  snapshot(): BackendState {
    if (this.state.uiStage === 'ready' && !this.ui?.isRunning()) {
      this.state.uiStage = 'error'; this.state.uiError = 'backend'
    }
    return { ...this.state }
  }

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
      const needsInstall = error instanceof SetupError && error.code === 'needs-install'
      this.state = { ...this.state, stage: controller.signal.aborted ? 'cancelled' : needsInstall ? 'needs-install' : 'error',
        error: controller.signal.aborted || needsInstall ? null : error instanceof SetupError ? error.code
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
      this.state.source = 'managed'
      launch = await prepareManagedBackend({
        root: managedDirectory(this.config.managedDir), signal,
        allowInstall: this.config.autoInstall || installRequested,
        progress: stage => this.stage(stage),
        verify: launch => checkBackend(this.bridge(launch), { signal }),
      })
    }
    signal.throwIfAborted()
    this.stage('connecting')
    const disconnect = await this.connect(this.bridge(launch))
    if (signal.aborted || this.disposed) { await disconnect(); signal.throwIfAborted(); return }
    this.disconnect = disconnect
    this.stage('ready')
  }

  async cancel(): Promise<void> {
    if (this.state.uiStage && activeStages.includes(this.state.uiStage)) {
      this.uiController?.abort(); await this.opening; return
    }
    if (!activeStages.includes(this.state.stage)) return
    this.controller?.abort()
    await this.active
  }

  startUi(installRequested = false): Promise<void> {
    if (this.opening) return this.opening
    if (this.disposed || this.state.stage !== 'ready' || this.state.uiStage === 'ready') return Promise.resolve()
    const controller = new AbortController()
    this.uiController = controller
    this.state.uiStage = 'checking'; this.state.uiError = null
    this.opening = (async () => {
      const signal = controller.signal
      // The UI always uses the bundled backend version, with the same host data
      // and runtime paths as MCP. Its private listener never claims ui_state.
      const launch = await prepareManagedBackend({
        root: managedDirectory(this.config.managedDir), signal,
        allowInstall: this.config.autoInstall || installRequested,
        progress: stage => { this.state.uiStage = stage },
        verify: launch => checkBackend(this.bridge(launch), { signal }),
      })
      this.state.uiStage = 'connecting'
      const ui = new EmbeddedUi()
      this.ui = ui
      await ui.start(launch.command, this.bridge(launch).env ?? {}, signal)
      signal.throwIfAborted()
      this.state.uiStage = 'ready'
    })().catch(async error => {
      await this.ui?.dispose(); this.ui = undefined
      this.state.uiStage = controller.signal.aborted ? 'cancelled'
        : error instanceof SetupError && error.code === 'needs-install' ? 'needs-install' : 'error'
      this.state.uiError = ['cancelled', 'needs-install'].includes(this.state.uiStage) ? null
        : error instanceof SetupError ? error.code : 'backend'
    }).finally(() => { this.opening = undefined })
    return this.opening
  }

  uiFrame(): Promise<Response> { return this.ui?.frame() ?? Promise.resolve(new Response(null, { status: 503 })) }
  uiRequest(request: Request): Promise<Response> { return this.ui?.proxy(request) ?? Promise.resolve(new Response(null, { status: 503 })) }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    this.uiController?.abort()
    await this.active
    await this.opening?.catch(() => {})
    await this.ui?.dispose()
    await this.disconnect?.()
  }
}

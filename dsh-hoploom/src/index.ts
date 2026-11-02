import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config, type Config as PluginConfig } from './config.js'
import { instructions } from './instructions.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BackendManager } from './manager.js'
import { backendHandler } from './api.js'
import { API_ROUTE } from './state.js'
import { UI_ROOT, UI_API, uiAsset } from './embedded.js'

export const name = 'dsh-hoploom'
export const inject = ['tools']
export { Config } from './config.js'

export function apply(ctx: Context, input: PluginConfig): void {
  const config = Config(input)
  const manager = new BackendManager(config, async bridge => {
    // The official client owns protocol, tool schemas, cancellation and cleanup.
    const fiber = ctx.plugin(mcpClient, bridge)
    try {
      await fiber
      if (!ctx.tools.get('mcp__hoploom__list_hosts')) throw new Error('Hoploom tools unavailable')
    } catch (error) { await fiber.dispose(); throw error }
    return async () => { await fiber.dispose() }
  })
  ctx.effect(() => () => manager.dispose())
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hoploom_setup',
    description: 'Inspect Hoploom setup, retry preparation or cancel a pending installation. Reuses existing Hoploom or prepares the bundled backend; does not enable remote SSH tools or change credentials.',
    parameters: { action: { type: 'string', enum: ['status', 'prepare', 'cancel'], required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, state) => [{ type: 'text', text: JSON.stringify(state) }],
    },
    async execute({ action }, exec) {
      exec.signal.throwIfAborted()
      if (action === 'prepare') void manager.start(true)
      if (action === 'cancel') await manager.cancel()
      return { ...manager.snapshot() }
    },
  })))
  ctx.inject(['connection'], inner => {
    const connection = inner.get('connection') as {
      fetch: { register(route: { path: string; methods: string[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }): () => void }
    }
    inner.effect(() => connection.fetch.register({
      path: '/' + API_ROUTE, methods: ['POST'], requestBody: 'buffered', fetch: backendHandler(manager),
    }))
    inner.effect(() => connection.fetch.register({ path: UI_ROOT, methods: ['GET'], requestBody: 'buffered', fetch: () => manager.uiFrame() }))
    inner.effect(() => connection.fetch.register({ path: UI_API, methods: ['POST'], requestBody: 'streaming', fetch: request => manager.uiRequest(request) }))
    for (const asset of ['ui.js', 'ui.css'] as const) inner.effect(() => connection.fetch.register({
      path: '/api/dsh-hoploom/' + asset, methods: ['GET'], requestBody: 'buffered', fetch: () => uiAsset(asset),
    }))
  })
  ctx.inject(['systemPrompt'], inner => {
    inner.systemPrompt.section({
      name: 'hoploom:workflow',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: instructions,
    })
  })
  // Keep the panel and recovery API available while the backend is being prepared.
  void manager.start()
}

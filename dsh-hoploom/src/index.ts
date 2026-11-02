import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { bridgeConfig, type Config as PluginConfig } from './config.js'
import { instructions } from './instructions.js'

export const name = 'dsh-hoploom'
export const inject = ['tools']
export { Config } from './config.js'

export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const bridge = bridgeConfig(config)
  // Use the supported client lifecycle on this plugin's scope. Registration,
  // cancellation, reconnects and disposal stay owned by the upstream bridge.
  await mcpClient.apply(ctx, bridge)
  ctx.inject(['systemPrompt'], inner => {
    inner.systemPrompt.section({
      name: 'hoploom:workflow',
      order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
      interpolate: false,
      text: instructions,
    })
  })
}

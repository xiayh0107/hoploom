import { isAbsolute } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client'

export interface Config {
  command: string
  commandArgs: string[]
  allowRemote: boolean
  allowExec: boolean
  allowCommands: string[]
  dataDir: string
  runtimeDir: string
  toolCallTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  command: Schema.string().default('hoploom').description('Hoploom executable or absolute path. No shell command or secrets.'),
  commandArgs: Schema.array(String).default([]).description('Arguments before mcp serve; for example the Hoploom Python launcher path.'),
  allowRemote: Schema.boolean().default(false).description('Expose test_host, which contacts a selected SSH host.'),
  allowExec: Schema.boolean().default(false).description('Expose run_command. Requires at least one allowed command pattern.'),
  allowCommands: Schema.array(String).default([]).description('Hoploom command allowlist globs, for example uptime or journalctl -u *. Never put secrets here.'),
  dataDir: Schema.string().default('').description('Optional absolute path to a separate Hoploom metadata directory.'),
  runtimeDir: Schema.string().default('').description('Optional absolute path to a separate Hoploom runtime directory.'),
  toolCallTimeoutMs: Schema.number().step(1).min(1000).max(660000).default(660000)
    .description('MCP call deadline in milliseconds; the backend still enforces each command timeout.'),
})

/** Validate before spawning. Only explicit, non-secret directory overrides pass through. */
export function bridgeConfig(input: Config): StdioConfig {
  const config = Config(input)
  if (!config.command.trim() || config.command.includes('\0')) {
    throw new Error('dsh-hoploom: command must name a local executable.')
  }
  if (config.commandArgs.some(arg => arg.includes('\0'))) {
    throw new Error('dsh-hoploom: commandArgs cannot contain NUL characters.')
  }
  if (config.allowCommands.some(pattern => !pattern.trim() || pattern.includes('\0'))) {
    throw new Error('dsh-hoploom: allowed command patterns must be non-empty and contain no NUL.')
  }
  if (config.allowExec && config.allowCommands.length === 0) {
    throw new Error('dsh-hoploom: allowExec requires at least one allowCommands pattern.')
  }
  const args = [...config.commandArgs, 'mcp', 'serve']
  if (config.allowRemote) args.push('--allow-remote')
  if (config.allowExec) {
    args.push('--allow-exec')
    for (const pattern of config.allowCommands) args.push('--allow-command', pattern)
  }
  const env: Record<string, string> = {}
  for (const [key, value] of [['SSM_DATA_DIR', config.dataDir], ['SSM_RUNTIME_DIR', config.runtimeDir]]) {
    if (!value) continue
    if (value.includes('\0') || !isAbsolute(value)) {
      throw new Error(`dsh-hoploom: ${key} override must be an absolute path.`)
    }
    env[key] = value
  }
  return {
    transport: 'stdio', serverName: 'hoploom', command: config.command,
    args, env, cwd: '', toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: true,
    // Missing executables should produce one actionable failure, not a retry storm.
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 3 },
  }
}

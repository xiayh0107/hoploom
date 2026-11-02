import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { Config, bridgeConfig } from '../lib/config.js'

test('default bridge is stdio and grants only metadata access', () => {
  const bridge = bridgeConfig(Config({}))
  assert.equal(bridge.transport, 'stdio')
  assert.equal(bridge.serverName, 'hoploom')
  assert.deepEqual(bridge.args, ['mcp', 'serve'])
  assert.deepEqual(bridge.env, {})
  assert.equal(bridge.failOnStartupError, true)
})

test('remote checks and command execution are independent explicit grants', () => {
  assert.deepEqual(bridgeConfig(Config({ allowRemote: true })).args,
    ['mcp', 'serve', '--allow-remote'])
  const pattern = 'journalctl -u *; $(echo never-local)'
  const bridge = bridgeConfig(Config({
    command: '/a directory/python', commandArgs: ['/a directory/hoploom.py'],
    allowExec: true, allowCommands: ['uptime', pattern],
  }))
  assert.equal(bridge.command, '/a directory/python')
  assert.deepEqual(bridge.args, ['/a directory/hoploom.py', 'mcp', 'serve',
    '--allow-exec', '--allow-command', 'uptime', '--allow-command', pattern])
  assert.ok(!bridge.args.includes('--allow-remote'))
})

test('an allowlist alone cannot enable execution', () => {
  assert.deepEqual(bridgeConfig(Config({ allowCommands: ['*'] })).args, ['mcp', 'serve'])
})

test('invalid or empty execution policies fail before a process can start', () => {
  for (const value of [[], [''], ['  '], ['uptime\0']]) {
    assert.throws(() => bridgeConfig(Config({ allowExec: true, allowCommands: value })))
  }
  assert.throws(() => bridgeConfig(Config({ command: ' ' })))
  assert.throws(() => bridgeConfig(Config({ commandArgs: ['bad\0'] })))
  for (const value of [0, -1, 999, 660001, 1500.5]) {
    assert.throws(() => bridgeConfig(Config({ toolCallTimeoutMs: value })))
  }
})

test('directory overrides are absolute and never form shell arguments', () => {
  const dataDir = resolve('isolated data')
  const runtimeDir = resolve('isolated runtime')
  assert.deepEqual(bridgeConfig(Config({ dataDir, runtimeDir })).env,
    { SSM_DATA_DIR: dataDir, SSM_RUNTIME_DIR: runtimeDir })
  for (const value of ['relative', '~/data', '/bad\0']) {
    assert.throws(() => bridgeConfig(Config({ dataDir: value })))
  }
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

const python = process.env.HOPLOOM_TEST_PYTHON
const scripts = fileURLToPath(new URL('../../ssh-server-manager/scripts/', import.meta.url))
const launcher = join(scripts, 'hoploom.py')
let sequence = 0

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-hoploom-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const dataDir = join(directory, 'data')
  const runtimeDir = join(directory, 'runtime')
  execFileSync(python, ['-c', `
from pathlib import Path
from ssh_server_manager.db import Database
from ssh_server_manager.paths import database_path
db = Database(database_path())
db.create_server(alias='web1', hostname='web1.invalid', username='deploy', tags=['test'])
db.create_server(alias='db1', hostname='db1.invalid', username='alice', proxy_jumps=['web1'])
db.create_server_path('web1', label='app', path='/srv/app')
`], {
    env: { ...process.env, PYTHONPATH: scripts, SSM_DATA_DIR: dataDir,
      SSM_RUNTIME_DIR: runtimeDir, SSM_MANAGED_SSH_CONFIG: join(directory, 'managed.conf'),
      SSM_ORIGINAL_SSH_CONFIG: join(directory, 'missing-config') },
    stdio: 'pipe',
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin(plugin, {
    command: python, commandArgs: [launcher], dataDir, runtimeDir, ...overrides,
  })
  await fiber
  return { ctx, fiber }
}

async function call(ctx, name, args = {}, signal = new AbortController().signal) {
  return ctx.tools.execute({
    callId: `hoploom-test-${++sequence}`, name: `mcp__hoploom__${name}`, arguments: args, signal,
  })
}

function payload(result) {
  assert.equal(result.isError, false, JSON.stringify(result.content))
  return JSON.parse(result.content.find(block => block.type === 'text').text)
}

test('real DSH registry discovers and calls the isolated Python backend', { skip: !python, timeout: 30000 }, async t => {
  const { ctx, fiber } = await fixture(t)
  const names = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('mcp__hoploom__'))
  assert.deepEqual(names.sort(), ['list_hosts', 'host_route', 'saved_paths', 'host_skills',
    'list_tunnels', 'runtime_capabilities'].map(name => `mcp__hoploom__${name}`).sort())
  const { hosts } = payload(await call(ctx, 'list_hosts', { tag: 'test' }))
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].alias, 'web1')
  assert.equal(hosts[0].last_test_status, null)
  const route = payload(await call(ctx, 'host_route', { host: 'db1' }))
  assert.match(JSON.stringify(route), /web1/)
  assert.match(JSON.stringify(payload(await call(ctx, 'saved_paths', { hosts: ['web1'] }))), /\/srv\/app/)
  payload(await call(ctx, 'host_skills', { hosts: ['web1'] }))
  payload(await call(ctx, 'list_tunnels'))
  const capability = payload(await call(ctx, 'runtime_capabilities'))
  assert.equal(capability.remote_tools, false)
  assert.equal(capability.exec_tools, false)
  assert.equal((await call(ctx, 'run_command', { host: 'web1', command: ['uptime'] })).isError, true)
  const prompt = renderPrompt(await ctx.systemPrompt.assemble())
  assert.match(prompt, /host_skills/)
  assert.match(prompt, /never bypass it/)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__hoploom__')).length, 0)
  assert.ok(!renderPrompt(await ctx.systemPrompt.assemble()).includes('Hoploom manages'))
})

test('remote opt-ins register tools but backend rejects non-allowlisted commands before SSH', { skip: !python, timeout: 30000 }, async t => {
  const { ctx } = await fixture(t, { allowRemote: true, allowExec: true, allowCommands: ['uptime'] })
  assert.ok(ctx.tools.get('mcp__hoploom__test_host'))
  assert.ok(ctx.tools.get('mcp__hoploom__run_command'))
  const result = await call(ctx, 'run_command', { host: 'web1', command: ['uname', '-a'] })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /allowlist/)
  // A pre-cancelled request must never reach the remote test handler.
  const controller = new AbortController()
  controller.abort()
  assert.equal((await call(ctx, 'test_host', { host: 'web1' }, controller.signal)).isError, true)
  assert.equal(payload(await call(ctx, 'list_hosts', { query: 'web1' })).hosts[0].last_test_status, null)
})

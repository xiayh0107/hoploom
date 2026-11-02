import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { checkBackend, resolveCommand } from '../lib/backend.js'
import { bridgeConfig, Config } from '../lib/config.js'

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'hoploom-lookup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function executable(directory, name = 'hoploom') {
  await mkdir(directory, { recursive: true })
  const filename = join(directory, name + (process.platform === 'win32' ? '.CMD' : ''))
  await writeFile(filename, '', { mode: 0o700 })
  return filename
}

test('desktop lookup finds the source installer with no user bin directory in PATH', async t => {
  const home = await directory(t)
  const local = await executable(join(home, '.local', 'bin'))
  assert.equal(await resolveCommand('hoploom', { home, env: { PATH: '' } }), local)
  const preferred = await executable(join(home, 'preferred'))
  assert.equal(await resolveCommand('hoploom', { home, env: { PATH: join(home, 'preferred') } }), preferred)
})

test('explicit missing executables never fall back to a different installation', async t => {
  const home = await directory(t)
  await executable(join(home, '.local', 'bin'))
  for (const command of [join(home, 'missing'), 'custom-hoploom']) {
    await assert.rejects(resolveCommand(command, { home, env: { PATH: '' } }), /not found.*Install or update Hoploom/)
  }
})

test('lookup ignores relative PATH entries and rejects relative configured paths', async t => {
  const home = await directory(t)
  await assert.rejects(resolveCommand('hoploom-test-no-such-executable', {
    home, env: { PATH: `.${delimiter}${delimiter}relative-bin` },
  }), /not found/)
  await assert.rejects(resolveCommand('./hoploom', { home }), /absolute path/)
})

test('Windows source installer is found through case-insensitive environment names', {
  skip: process.platform !== 'win32',
}, async t => {
  const home = await directory(t)
  const localAppData = join(home, 'Local App Data')
  const launcher = await executable(join(localAppData, 'hoploom', 'bin'))
  assert.equal(await resolveCommand('hoploom', {
    home, env: { Path: '', LocalAppData: localAppData, PathExt: '.CMD;.EXE' },
  }), launcher)
})

test('preflight preserves argv and directory overrides while scrubbing ambient secrets', async t => {
  const root = await directory(t)
  const script = join(root, 'check backend.cjs')
  const dataDir = join(root, 'no database created')
  await writeFile(script, `
const assert = require('node:assert/strict')
assert.deepEqual(process.argv.slice(2), ['mcp', 'serve', '--allow-exec', '--allow-command', 'echo $(not-a-shell); value', '--help'])
assert.equal(process.env.HOPLOOM_PREFLIGHT_TEST_TOKEN, undefined)
assert.equal(process.env.DSH_HOPLOOM_PREFLIGHT_TEST, undefined)
assert.equal(process.env.SSM_DATA_DIR, ${JSON.stringify(dataDir)})
`)
  process.env.HOPLOOM_PREFLIGHT_TEST_TOKEN = 'synthetic-test-value'
  process.env.DSH_HOPLOOM_PREFLIGHT_TEST = 'synthetic-test-value'
  t.after(() => {
    delete process.env.HOPLOOM_PREFLIGHT_TEST_TOKEN
    delete process.env.DSH_HOPLOOM_PREFLIGHT_TEST
  })
  await checkBackend(bridgeConfig(Config({ command: process.execPath, commandArgs: [script],
    dataDir, allowExec: true, allowCommands: ['echo $(not-a-shell); value'] })))
})

test('old or broken backends fail with recovery instructions, without leaking their stderr', async t => {
  const root = await directory(t)
  const script = join(root, 'old-backend.cjs')
  await writeFile(script, "console.error('synthetic-private-diagnostic'); process.exit(2)")
  await assert.rejects(checkBackend(bridgeConfig(Config({
    command: process.execPath, commandArgs: [script],
  }))), error => {
    assert.match(error.message, /cannot run mcp serve --help.*MCP support.*Install or update Hoploom/)
    assert.ok(!error.message.includes('synthetic-private-diagnostic'))
    return true
  })
})

test('preflight terminates a hanging backend on timeout or disposal', { timeout: 5000 }, async t => {
  const root = await directory(t)
  const script = join(root, 'hang.cjs')
  await writeFile(script, 'setInterval(() => {}, 1000)')
  const bridge = bridgeConfig(Config({ command: process.execPath, commandArgs: [script] }))
  await assert.rejects(checkBackend(bridge, { timeoutMs: 100 }), /timed out/)
  const controller = new AbortController()
  const started = checkBackend(bridge, { signal: controller.signal })
  controller.abort()
  await assert.rejects(started, /cancelled/)
})

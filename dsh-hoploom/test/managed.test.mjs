import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { zipSync } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'
import { extractUv } from '../lib/archive.js'
import { bundledWheel, downloadVerified, installationLock, prepareManagedBackend } from '../lib/managed.js'
import { checkBackend } from '../lib/backend.js'
import { bridgeConfig, Config } from '../lib/config.js'
import { runLocal, startLocal } from '../lib/process.js'

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'hoploom-managed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('archive extraction selects only uv, never archive-provided filesystem paths', () => {
  const bytes = Buffer.from('synthetic-executable')
  const zip = zipSync({ 'uv.exe': bytes, '../outside.exe': bytes, 'nested/uv.exe': bytes })
  assert.deepEqual(extractUv(Buffer.from(zip), 'uv-windows.zip'), bytes)
  assert.throws(() => extractUv(Buffer.from(zipSync({ '../uv.exe': bytes })), 'uv-windows.zip'))
})

test('download verifies the complete checksum before any executable is used', async t => {
  const body = Buffer.from('download fixture')
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  const digest = createHash('sha256').update(body).digest('hex')
  assert.deepEqual(await downloadVerified('https://example.invalid/uv', digest, new AbortController().signal), body)
  await assert.rejects(downloadVerified('https://example.invalid/uv', '0'.repeat(64), new AbortController().signal), { code: 'integrity' })
  await assert.rejects(downloadVerified('https://example.invalid/uv', digest, AbortSignal.abort()), { name: 'AbortError' })
})

test('parallel installers serialize, recover a dead owner and cannot remove a successor lock', async t => {
  const root = await temporary(t)
  const lock = join(root, 'install.lock')
  await mkdir(lock)
  await writeFile(join(lock, `owner-${randomUUID()}.json`), JSON.stringify({ pid: 2147483647, id: randomUUID() }))
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    const release = await installationLock(root, new AbortController().signal, () => {})
    peak = Math.max(peak, ++active)
    await delay(40)
    active--
    await release()
  }))
  assert.equal(peak, 1)
  const release = await installationLock(root, new AbortController().signal, () => {})
  await release()
  const successor = await installationLock(root, new AbortController().signal, () => {})
  await release()
  assert.equal((await readdir(lock)).length, 1)
  const controller = new AbortController()
  const waiting = installationLock(root, controller.signal, () => controller.abort())
  await assert.rejects(waiting, { name: 'AbortError' })
  await successor()
})

test('cancellation stops a child before cleanup; an already-cancelled call spawns nothing', async t => {
  const root = await temporary(t)
  const script = join(root, 'worker.cjs')
  const marker = join(root, 'started')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},100)`)
  await assert.rejects(runLocal(process.execPath, [script], { signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(access(marker))
  const controller = new AbortController()
  const child = startLocal(process.execPath, [script], { signal: controller.signal })
  for (let i = 0; i < 100; i++) { try { await access(marker); break } catch { await delay(20) } }
  const pid = Number(await readFile(marker, 'utf8'))
  controller.abort()
  await child.stop()
  await assert.rejects(async () => process.kill(pid, 0))
  await assert.rejects(runLocal(process.execPath, ['-e', 'setInterval(()=>{},100)'], { timeoutMs: 50 }), { code: 'timeout' })
})

test('bundled wheel checksum rejects tampering', async t => {
  const root = await temporary(t)
  const { path, manifest } = await bundledWheel()
  assert.match(path, /hoploom-.*\.whl$/)
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(root, manifest.filename), 'not the packaged wheel')
  await assert.rejects(bundledWheel(root), { code: 'integrity' })
})

test('fresh managed install downloads its own Python and survives an offline second start', {
  skip: process.env.HOPLOOM_TEST_BOOTSTRAP !== '1', timeout: 600000,
}, async t => {
  const root = await temporary(t)
  const stages = []
  const signal = new AbortController().signal
  const verify = launch => checkBackend(bridgeConfig(Config({ ...launch,
    dataDir: join(root, 'data'), runtimeDir: join(root, 'runtime') })), { signal })
  // A fresh UV_PYTHON_INSTALL_DIR plus --managed-python excludes system Python.
  const launch = await prepareManagedBackend({ root, signal, progress: stage => stages.push(stage), verify })
  assert.ok(stages.includes('downloading') && stages.includes('python') && stages.includes('installing'))
  assert.ok((await readdir(join(root, 'python'))).some(name => name.startsWith('cpython-')))
  assert.ok(launch.command.startsWith(root))
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline') })
  assert.deepEqual(await prepareManagedBackend({ root, signal, progress: () => assert.fail('cached startup should not install'), verify }), launch)
  await assert.rejects(access(join(root, 'data')), 'help checks must not create a host database')
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { ...launch, dataDir: join(root, 'data'), runtimeDir: join(root, 'runtime') })
    for (let i = 0; i < 150 && !ctx.tools.get('mcp__hoploom__list_hosts'); i++) await delay(100)
    assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__hoploom__')).length, 6)
    const response = await ctx.tools.execute({ name: 'mcp__hoploom__list_hosts', callId: 'bundled-install', arguments: {}, signal })
    assert.equal(response.isError, false)
    assert.deepEqual(JSON.parse(response.content.find(block => block.type === 'text').text).hosts, [])
  } finally { await ctx.fiber.dispose() }
})

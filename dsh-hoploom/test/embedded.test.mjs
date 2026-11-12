import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { EmbeddedUi, uiAsset } from '../lib/embedded.js'

const python = process.env.HOPLOOM_TEST_PYTHON
const scripts = fileURLToPath(new URL('../../ssh-server-manager/scripts/', import.meta.url))

test('embedded UI reuses Hoploom endpoints with per-frame sessions, CSRF and a private loopback transport', { skip: !python, timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hoploom-ui-bridge-'))
  const ui = new EmbeddedUi()
  const controller = new AbortController()
  t.after(async () => { await ui.dispose(); await rm(root, { recursive: true, force: true }) })
  await ui.start(python, { PYTHONPATH: scripts, SSM_DATA_DIR: join(root, 'data'), SSM_RUNTIME_DIR: join(root, 'runtime'),
    SSM_MANAGED_SSH_CONFIG: join(root, 'managed-config'), SSM_ORIGINAL_SSH_CONFIG: join(root, 'missing-config') }, controller.signal)
  const frame = async () => {
    const response = await ui.frame()
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/)
    const html = await response.text()
    assert.ok(!html.includes('?token='))
    return html.match(/name="hoploom-frame" content="([a-f0-9]+)"/)[1]
  }
  const id = await frame()
  const call = (frameId, path, method = 'GET', body, csrf, origin = 'http://dsh.example') => ui.proxy(new Request('http://dsh.example/api/dsh-hoploom/ui-api?path=' + encodeURIComponent(path), {
    method: 'POST', headers: { 'x-hoploom-frame': frameId, 'x-hoploom-origin': origin, 'x-hoploom-method': method,
      ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
  assert.equal((await fetch(`http://127.0.0.1:${ui.port}/api/v1/runtime`)).status, 403)
  assert.equal((await call('0'.repeat(64), '/runtime')).status, 401)
  assert.equal((await call(id, '/../runtime')).status, 400)
  assert.equal((await call(id, '/runtime', 'GET', undefined, undefined, 'https://other.invalid')).status, 403)
  const bootstrap = await call(id, '/runtime')
  assert.equal(bootstrap.status, 200)
  assert.equal(bootstrap.headers.get('set-cookie'), null)
  const state = await bootstrap.json()
  assert.ok(state.csrf)
  const host = { alias: 'ui-fixture', hostname: 'ui-fixture.invalid', username: 'user' }
  assert.equal((await call(id, '/hosts', 'POST', host)).status, 403)
  const created = await call(id, '/hosts', 'POST', host, state.csrf)
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
  const other = await frame()
  const second = await (await call(other, '/runtime')).json()
  assert.notEqual(state.csrf, second.csrf)
  assert.equal((await call(other, '/hosts', 'POST', { ...host, alias: 'another' }, state.csrf)).status, 403)
  const hosts = await (await call(id, '/hosts')).json()
  assert.match(JSON.stringify(hosts), /ui-fixture/)
  assert.equal((await call(other, '/_frame', 'DELETE')).status, 204)
  assert.equal((await call(other, '/runtime')).status, 401)
  assert.equal((await call(id, '/runtime')).status, 200)
  const native = await frame()
  const nativeState = await (await call(native, '/runtime', 'GET', undefined, undefined, 'dsh-app://app')).json()
  assert.equal(nativeState.auth.webauthn_available, false)
  assert.equal((await call(native, '/runtime')).status, 403, 'A frame cannot switch origins')
  assert.equal((await uiAsset('ui.js')).status, 200)
  assert.equal((await uiAsset('ui.css')).status, 200)
  controller.abort()
  await ui.dispose()
  assert.equal((await call(id, '/runtime')).status, 503)
})

test('UI tunnel streams multipart uploads and downloads, strips cookies, and cancels pending responses', { timeout: 10000 }, async t => {
  let received = '', contentType = ''
  const server = createServer(async (request, response) => {
    if (request.url.endsWith('/pending')) {
      response.on('close', () => server.emit('pending-close'))
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write('{"type":"progress"}\n')
      return
    }
    contentType = request.headers['content-type']
    for await (const part of request) received += part.toString()
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'private=hidden',
      'content-disposition': 'attachment; filename="fixture.txt"', 'content-length': '17' })
    response.write('download ')
    response.end('contents')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const ui = new EmbeddedUi()
  // A loopback fixture exercises the real transport without opening an SSH session.
  ui.port = server.address().port
  ui.process = { child: { exitCode: null, signalCode: null } }
  const html = await (await ui.frame()).text()
  const id = html.match(/name="hoploom-frame" content="([a-f0-9]+)"/)[1]
  const request = (path, body, signal) => new Request('http://dsh.example/api/dsh-hoploom/ui-api?path=' + encodeURIComponent(path), {
    method: 'POST', headers: { 'x-hoploom-frame': id, 'x-hoploom-origin': 'http://dsh.example', 'x-hoploom-method': 'POST' }, body, signal,
  })
  const body = new FormData()
  body.set('file', new Blob(['fixture upload']), 'fixture.txt')
  const response = await ui.proxy(request('/upload', body))
  assert.match(contentType, /^multipart\/form-data; boundary=/)
  assert.match(received, /fixture upload/)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.match(response.headers.get('content-disposition'), /fixture.txt/)
  assert.equal(response.headers.get('content-length'), '17')
  assert.equal(await response.text(), 'download contents')
  const bodyDisconnected = once(server, 'pending-close')
  const cancelledBody = await ui.proxy(request('/pending'))
  const bodyReader = cancelledBody.body.getReader()
  assert.equal((await bodyReader.read()).done, false)
  await bodyReader.cancel()
  await bodyDisconnected
  const controller = new AbortController()
  const disconnected = once(server, 'pending-close')
  const pending = await ui.proxy(request('/pending', undefined, controller.signal))
  const reader = pending.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /progress/)
  controller.abort()
  await disconnected
  await reader.cancel().catch(() => {})
})

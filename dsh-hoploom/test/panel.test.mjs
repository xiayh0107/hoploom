import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { backendHandler } from '../lib/api.js'
import { BackendManager } from '../lib/manager.js'
import { Config } from '../lib/config.js'

const missing = process.platform === 'win32' ? 'Z:\\hoploom-does-not-exist\\hoploom.exe' : '/hoploom-does-not-exist/hoploom'

test('a failed custom backend leaves recovery API available and never installs a replacement', async () => {
  let connected = false
  const manager = new BackendManager(Config({ command: missing }), async () => { connected = true; return async () => {} })
  try {
    await manager.start()
    assert.equal(connected, false)
    assert.equal(manager.snapshot().error, 'custom-command')
    const handler = backendHandler(manager)
    const request = body => new Request('https://dsh.invalid/api/dsh-hoploom/backend', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal((await handler(request({ action: 'status' }))).status, 200)
    for (const body of [{ action: 'run_command' }, { action: 'prepare', command: 'arbitrary' }, [], { action: 'x'.repeat(2000) }]) {
      assert.equal((await handler(request(body))).status, 400)
    }
    const response = await handler(request({ action: 'open' }))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, 'open-failed')
    const preparation = await handler(request({ action: 'prepare' }))
    assert.equal(preparation.status, 200)
    await manager.start()
    assert.equal(manager.snapshot().error, 'custom-command')
  } finally { await manager.dispose() }
})

test('built client registers a sidebar entry and renders recoverable setup without opening UI on mount', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://dsh.invalid/' })
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  })
  const calls = [], registrations = [], disposers = [], listeners = new Set()
  let exported, dictionaries, locale = 'zh', snapshot = { active: locale }
  let backend = { stage: 'error', error: 'download', source: 'managed', remoteEnabled: false, execEnabled: false }
  const context = {
    window: { __ModuleLoader__: { load: module => { exported = module.factory(name => { assert.equal(name, 'react'); return React }) } } },
    console, setTimeout, clearTimeout, AbortController,
    fetch: async (url, options) => {
      assert.equal(url, 'api/dsh-hoploom/backend')
      assert.equal(options.credentials, 'same-origin')
      const { action } = JSON.parse(options.body)
      calls.push(action)
      if (action === 'prepare') backend = { ...backend, stage: 'ready', error: null }
      return Response.json({ state: backend, ...(action === 'open' ? { opened: true } : {}) })
    },
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context)
  const ctx = {
    effect: fn => disposers.push(fn()),
    locale: {
      register: (_namespace, values) => { dictionaries = values; return () => {} },
      bind: () => key => dictionaries[locale][key],
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      getSnapshot: () => snapshot,
    },
    slots: {
      inject: (_name, fn) => disposers.push(fn()),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }
  exported.apply(ctx)
  const sidebar = registrations.find(item => item.options.name === 'sidebar.panellist')
  const panel = registrations.find(item => item.options.name === 'main')
  assert.equal(sidebar.options.id, panel.options.key)
  assert.equal(sidebar.options.label(), 'Hoploom')
  const root = createRoot(document.querySelector('#root'))
  try {
    await React.act(async () => root.render(React.createElement(panel.component)))
    assert.match(document.body.textContent, /运行环境下载失败/)
    assert.deepEqual(calls, ['status'])
    const button = () => document.querySelector('button')
    assert.equal(button().textContent, '重试')
    await React.act(async () => button().click())
    assert.match(document.body.textContent, /已准备就绪/)
    assert.equal(button().textContent, '打开主机管理')
    assert.deepEqual(calls, ['status', 'prepare'])
    await React.act(async () => button().click())
    assert.equal(calls.at(-1), 'open')
    await React.act(async () => { locale = 'en'; snapshot = { active: locale }; for (const listener of listeners) listener() })
    assert.equal(button().textContent, 'Open host manager')
  } finally {
    await React.act(async () => root.unmount())
    for (const dispose of disposers.reverse()) dispose?.()
  }
  assert.equal(listeners.size, 0)
})

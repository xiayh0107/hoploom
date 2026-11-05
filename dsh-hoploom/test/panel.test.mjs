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
    assert.equal(response.status, 400)
    const preparation = await handler(request({ action: 'prepare' }))
    assert.equal(preparation.status, 200)
    await manager.start()
    assert.equal(manager.snapshot().error, 'custom-command')
  } finally { await manager.dispose() }
})

async function loadClient(t, { rightbar = true, onScreen = true, openFails = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://dsh.invalid/' })
  const previous = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const calls = [], registrations = [], types = [], navigation = [], disposers = [], listeners = new Set()
  let exported, dictionaries, locale = 'zh', snapshot = { active: locale }
  const fixture = { calls, registrations, types, navigation, listeners,
    backend: { stage: 'error', error: 'download', source: 'managed', remoteEnabled: false, execEnabled: false, uiStage: null, uiError: null } }
  const context = {
    window: { __ModuleLoader__: { load: module => { exported = module.factory(name => { assert.equal(name, 'react'); return React }) } } },
    console, setTimeout, clearTimeout, AbortController,
    fetch: async (url, options) => {
      assert.equal(url, 'api/dsh-hoploom/backend')
      assert.equal(options.credentials, 'same-origin')
      const { action } = JSON.parse(options.body)
      calls.push(action)
      if (action === 'prepare') fixture.backend = { ...fixture.backend, stage: 'ready', error: null, uiStage: 'ready' }
      return Response.json({ state: fixture.backend })
    },
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), context)
  const ctx = {
    effect: fn => disposers.push(fn()),
    inject: (dependencies, callback) => {
      assert.deepEqual([...dependencies], ['layout', 'sidebarRight', 'sidebarRightTabs'])
      if (!rightbar) return
      callback({ ...ctx,
        layout: { selectPanel: id => navigation.push(['select', id]) },
        sidebarRight: {
          mounted: { getSnapshot: () => onScreen && navigation.at(-1)?.[1] === null ? 'session-1' : undefined },
          openTab: kind => { if (openFails) throw new Error('no session surface'); navigation.push(['open', kind]) },
        },
        sidebarRightTabs: { register: definition => { types.push(definition); return () => {} } },
      })
    },
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
  fixture.slot = name => registrations.find(item => item.options.name === name)
  const root = createRoot(document.querySelector('#root'))
  fixture.render = component => React.act(async () => root.render(React.createElement(component)))
  t.after(async () => {
    await React.act(async () => root.unmount())
    for (const dispose of disposers.reverse()) dispose?.()
    assert.equal(listeners.size, 0)
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  })
  return fixture
}

test('built client docks Hoploom in the right sidebar with recoverable setup, then embeds the existing UI', async t => {
  const client = await loadClient(t)
  const [type] = client.types
  assert.equal(client.types.length, 1)
  assert.equal(type.kind, 'hoploom')
  assert.equal(type.keepMounted, true)
  assert.equal(type.title(), 'Hoploom')
  assert.deepEqual(Array.from(type.guide, entry => [entry.title(), entry.description()]), [['Hoploom', '主机、凭据与文件']])
  assert.ok(type.guide[0].icon)
  const body = client.slot('sidebar.right.pane.tab')
  assert.equal(body.options.key, type.id)
  await client.render(body.component)
  assert.match(document.body.textContent, /运行环境下载失败/)
  assert.deepEqual(client.calls, ['status'])
  const button = () => document.querySelector('button')
  assert.equal(button().textContent, '重试')
  await React.act(async () => button().click())
  const iframe = document.querySelector('iframe')
  assert.equal(iframe.title, 'Hoploom')
  assert.equal(iframe.getAttribute('src'), 'api/dsh-hoploom/ui')
  assert.deepEqual(client.calls, ['status', 'prepare'])
  assert.ok(!client.calls.includes('open'))
})

test('the sidebar entry keeps the conversation and opens Hoploom beside it', async t => {
  const client = await loadClient(t)
  const sidebar = client.slot('sidebar.panellist'), panel = client.slot('main')
  assert.equal(sidebar.options.id, panel.options.key)
  assert.equal(sidebar.options.label(), 'Hoploom')
  await client.render(panel.component)
  assert.deepEqual(client.navigation, [['select', null], ['open', 'hoploom']])
  assert.equal(document.querySelector('#root').innerHTML, '')
  assert.deepEqual(client.calls, [])
})

for (const [name, options] of [
  ['without a Session on screen', { onScreen: false }],
  ['when the Session surface is not ready', { openFails: true }],
  ['without the right sidebar', { rightbar: false }],
]) test(`the sidebar entry shows Hoploom in place ${name}`, async t => {
  const client = await loadClient(t, options)
  await client.render(client.slot('main').component)
  assert.deepEqual(client.navigation, options.rightbar === false ? [] : [['select', null], ['select', 'hoploom']])
  assert.match(document.body.textContent, /运行环境下载失败/)
  assert.deepEqual(client.calls, ['status'])
})

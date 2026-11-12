import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { startLocal, type LocalProcess } from './process.js'
import { SetupError } from './state.js'

const script = fileURLToPath(new URL('../python/ui_bridge.py', import.meta.url))
export const UI_ROOT = '/api/dsh-hoploom/ui'
export const UI_API = '/api/dsh-hoploom/ui-api'
const CONTEXT_TTL = 12 * 60 * 60 * 1000

export class EmbeddedUi {
  private process?: LocalProcess
  private port?: number
  private key = randomBytes(32).toString('hex')
  private frames = new Map<string, { created: number; origin?: string }>()

  isRunning(): boolean {
    return !!this.port && !!this.process && this.process.child.exitCode === null && this.process.child.signalCode === null
  }

  async start(python: string, env: Record<string, string>, signal: AbortSignal): Promise<void> {
    const running = startLocal(python, [script], { env, signal, capture: true, input: JSON.stringify({ key: this.key }) + '\n' })
    this.process = running
    try {
      this.port = await new Promise<number>((accept, reject) => {
        let output = '', settled = false
        const finish = (port?: number, error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          running.child.stdout?.off('data', data)
          running.child.off('exit', fail)
          if (error) reject(error)
          else accept(port!)
        }
        const fail = () => finish(undefined, new SetupError('backend'))
        const timer = setTimeout(() => finish(undefined, new SetupError('timeout')), 30000)
        const data = (chunk: Buffer) => {
          output += chunk.toString('utf8')
          if (output.length > 1024) return fail()
          if (!output.includes('\n')) return
          try {
            const value = JSON.parse(output.split('\n')[0]).port
            if (!Number.isInteger(value) || value < 1 || value > 65535) return fail()
            finish(value)
          } catch { fail() }
        }
        running.child.stdout!.on('data', data)
        running.child.once('exit', fail)
        void running.done.then(fail, fail)
      })
    } catch (error) { await running.stop(); throw error }
  }

  async frame(): Promise<Response> {
    if (!this.isRunning()) return new Response('Hoploom is not ready', { status: 503 })
    for (const [id, frame] of this.frames) if (Date.now() - frame.created > CONTEXT_TTL) this.frames.delete(id)
    if (this.frames.size >= 128) return new Response('Too many open Hoploom views', { status: 429 })
    const id = randomBytes(32).toString('hex')
    this.frames.set(id, { created: Date.now() })
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="hoploom-frame" content="${id}"><title>Hoploom</title><link rel="stylesheet" href="./ui.css"><script type="module" src="./ui.js"></script></head><body><div id="root"></div></body></html>`
    return new Response(html, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    } })
  }

  async proxy(request: Request): Promise<Response> {
    if (!this.isRunning()) return new Response(null, { status: 503 })
    const id = request.headers.get('x-hoploom-frame') ?? ''
    const frame = this.frames.get(id)
    if (!frame || Date.now() - frame.created > CONTEXT_TTL) return new Response(null, { status: 401 })
    const origin = request.headers.get('x-hoploom-origin') ?? ''
    const permitted = [new URL(request.url).origin, request.headers.get('origin'), 'dsh-app://app']
    if (!permitted.includes(origin) || (frame.origin && frame.origin !== origin)) return new Response(null, { status: 403 })
    frame.origin = origin
    const path = new URL(request.url).searchParams.get('path') ?? ''
    const method = request.headers.get('x-hoploom-method') ?? ''
    if (request.method !== 'POST' || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      || !path.startsWith('/') || path.startsWith('//') || /[\\\0\r\n#]/.test(path)) return new Response(null, { status: 400 })
    const releasing = path === '/_frame' && method === 'DELETE'
    const target = new URL(releasing ? '/bridge/release' : '/api/v1' + path, `http://127.0.0.1:${this.port}`)
    if (!releasing && !target.pathname.startsWith('/api/v1/')) return new Response(null, { status: 400 })
    const headers: Record<string, string> = { authorization: 'Bearer ' + this.key,
      'x-hoploom-frame': id, 'x-hoploom-origin': origin }
    for (const name of ['content-type', 'x-csrf-token', 'accept']) {
      const value = request.headers.get(name)
      if (value) headers[name] = value
    }
    // A direct loopback connection cannot send this private transport key to a proxy.
    return new Promise<Response>(accept => {
      const outgoing = httpRequest(target, { method: releasing ? 'POST' : method, headers, signal: request.signal }, incoming => {
        if (releasing) this.frames.delete(id)
        const responseHeaders = new Headers({ 'cache-control': 'no-store' })
        for (const name of ['content-type', 'content-disposition', 'content-length']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') responseHeaders.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        if ([204, 304].includes(status) || method === 'HEAD') {
          incoming.resume(); accept(new Response(null, { status, headers: responseHeaders })); return
        }
        accept(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }))
      })
      outgoing.on('error', () => accept(new Response(null, { status: 502 })))
      if (request.body && !['GET', 'HEAD'].includes(method)) {
        const body = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream)
        body.on('error', () => outgoing.destroy())
        outgoing.on('close', () => body.destroy())
        body.pipe(outgoing)
      } else outgoing.end()
    })
  }

  async dispose(): Promise<void> { this.frames.clear(); await this.process?.stop(); this.port = undefined }
}

export async function uiAsset(name: 'ui.js' | 'ui.css'): Promise<Response> {
  return new Response(await readFile(new URL('../lib/' + name, import.meta.url)), { headers: {
    'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } })
}

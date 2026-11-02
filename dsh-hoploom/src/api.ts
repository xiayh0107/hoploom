import type { BackendManager } from './manager.js'

/** Served only by dsh's authenticated, owner-only Fetch route registry. */
export function backendHandler(manager: BackendManager) {
  return async (request: Request): Promise<Response> => {
    const respond = (body: unknown, status = 200) => Response.json(body, {
      status, headers: { 'cache-control': 'no-store' },
    })
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
      return respond({ error: 'invalid-request' }, 400)
    }
    let body: unknown
    try {
      const text = await request.text()
      if (text.length > 1024) return respond({ error: 'invalid-request' }, 400)
      body = JSON.parse(text)
    } catch { return respond({ error: 'invalid-request' }, 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'action')) {
      return respond({ error: 'invalid-request' }, 400)
    }
    const action = (body as { action?: string }).action
    switch (action) {
      case 'status': return respond({ state: manager.snapshot() })
      case 'prepare':
        if (manager.snapshot().stage === 'ready') void manager.startUi(true)
        else void manager.start(true)
        return respond({ state: manager.snapshot() })
      case 'cancel': await manager.cancel(); return respond({ state: manager.snapshot() })
      case 'start-ui': void manager.startUi(); return respond({ state: manager.snapshot() })
      default: return respond({ error: 'invalid-request' }, 400)
    }
  }
}

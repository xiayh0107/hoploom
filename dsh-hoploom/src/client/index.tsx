import * as React from 'react'
import { en, zh } from './i18n.js'
import { activeStages, API_ROUTE, type BackendState } from '../state.js'

interface ClientContext {
  effect(effect: () => () => void): unknown
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
    subscribe(listener: () => void): () => void
    getSnapshot(): unknown
  }
  slots: {
    inject(name: string, callback: () => unknown): unknown
    register(options: { name: string; key?: string; id?: string; order?: number; label?: () => string; locale?: string },
      component: React.ComponentType<any>): () => void
  }
}

function HoploomIcon({ size = 22 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 64 64" fill="none">
    <rect width="64" height="64" rx="14" fill="#0f766e" />
    <path d="M18 16v32m28-32v32M18 32h28" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
    <circle cx="32" cy="32" r="7" fill="#0f766e" stroke="#99f6e4" strokeWidth="4" />
  </svg>
}

const styles = `
.hoploom-panel{height:100%;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font:inherit;box-sizing:border-box}
.hoploom-inner{max-width:900px;margin:0 auto;padding:48px 32px 64px}
.hoploom-heading{display:flex;align-items:center;gap:16px;margin-bottom:36px}
.hoploom-panel h1{font-size:28px;line-height:1.2;letter-spacing:-.02em;margin:0 0 6px;font-weight:650}
.hoploom-panel h2{font-size:18px;line-height:1.4;margin:0 0 10px;font-weight:600}
.hoploom-panel p{margin:0;line-height:1.65}
.hoploom-muted{color:var(--dsw-alias-label-secondary,#858b93)}
.hoploom-card{border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:var(--dsw-radius-lg,16px);padding:28px;background:var(--dsw-alias-bg-layer-1,transparent)}
.hoploom-state{display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:18px;font-weight:600}
.hoploom-dot{width:9px;height:9px;border-radius:50%;background:#0f9488;flex:none}
.hoploom-dot[data-stage=error]{background:#d97757}.hoploom-dot[data-stage=cancelled],.hoploom-dot[data-stage=needs-install]{background:#8b9299}
.hoploom-progress{height:4px;background:var(--dsw-alias-border-l2,#8883);border-radius:8px;overflow:hidden;margin:22px 0}
.hoploom-progress span{display:block;height:100%;background:#0f9488;transition:width .25s ease}
.hoploom-actions{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:24px}
.hoploom-panel button{font:inherit;border:1px solid var(--dsw-alias-border-l2,#8885);border-radius:var(--dsw-radius-md,10px);background:transparent;color:inherit;padding:10px 16px;cursor:pointer}
.hoploom-panel button.primary{background:#0f766e;color:white;border-color:#0f766e;font-weight:550}
.hoploom-panel button:disabled{opacity:.5;cursor:default}.hoploom-panel button:focus-visible,.hoploom-panel a:focus-visible{outline:2px solid #14b8a6;outline-offset:3px}
.hoploom-panel button:not(:disabled):hover{filter:brightness(1.12)}
.hoploom-panel a{color:var(--dsw-alias-label-secondary,#858b93);text-underline-offset:3px}
.hoploom-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}
.hoploom-grid>div{padding:22px 0}.hoploom-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.hoploom-tags span{font-size:12px;border:1px solid var(--dsw-alias-border-l2,#8884);border-radius:20px;padding:4px 10px}
.hoploom-example{margin-top:24px!important;border-left:3px solid #0f9488;padding-left:15px}
.hoploom-notice{margin-top:16px!important;font-size:14px}.hoploom-error{color:var(--dsw-alias-label-primary,inherit)}
@media(max-width:640px){.hoploom-inner{padding:28px 20px}.hoploom-card{padding:20px}.hoploom-grid{grid-template-columns:1fr;gap:0}.hoploom-heading{margin-bottom:24px}}
`

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('dsh-hoploom', { en, zh }))
  const t = ctx.locale.bind('dsh-hoploom')
  function Panel() {
    React.useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot())
    const [state, setState] = React.useState<BackendState | null>(null)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState('')
    const [offline, setOffline] = React.useState(false)
    const alive = React.useRef(true)
    const requests = React.useRef(new Set<AbortController>())
    const generation = React.useRef(0)
    const startingUi = React.useRef(false)
    const request = React.useCallback(async (action: string) => {
      const controller = new AbortController()
      requests.current.add(controller)
      const sequence = ++generation.current
      try {
        const response = await fetch(API_ROUTE, { method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }), signal: controller.signal })
        const result = await response.json() as { state?: BackendState }
        if (!response.ok) throw new Error('request-failed')
        if (alive.current && sequence === generation.current && result.state) {
          setState(result.state); setOffline(false)
        }
        return result
      } finally { requests.current.delete(controller) }
    }, [])
    React.useEffect(() => {
      alive.current = true
      let timer: ReturnType<typeof setTimeout>
      async function poll() {
        try { await request('status') }
        catch { if (alive.current) setOffline(true) }
        if (alive.current) timer = setTimeout(poll, 1500)
      }
      void poll()
      return () => {
        alive.current = false; clearTimeout(timer)
        for (const request of requests.current) request.abort()
      }
    }, [request])
    React.useEffect(() => {
      if (state?.stage !== 'ready' || state.uiStage !== null || startingUi.current) return
      startingUi.current = true
      void request('start-ui').catch(() => { if (alive.current) { startingUi.current = false; setOffline(true) } })
    }, [state, request])
    async function action(value: string) {
      setBusy(true); setNotice('')
      try {
        await request(value)
      } catch {
        if (alive.current) setNotice('connectionFailed')
      } finally { if (alive.current) setBusy(false) }
    }
    if (state?.stage === 'ready' && state.uiStage === 'ready') return <iframe
      title="Hoploom" src="api/dsh-hoploom/ui" style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      allow="publickey-credentials-get 'self'; publickey-credentials-create 'self'" />
    const stage = state?.stage === 'ready' ? state.uiStage ?? 'checking' : state?.stage ?? 'checking'
    const error = state?.stage === 'ready' ? state.uiError : state?.error
    const active = activeStages.includes(stage)
    const progress = ({ checking: 8, waiting: 12, downloading: 25, python: 50, installing: 75, connecting: 92 } as Record<string, number>)[stage] ?? 0
    return <section className="hoploom-panel" aria-label={t('title')}>
      <style>{styles}</style>
      <div className="hoploom-inner">
        <header className="hoploom-heading"><HoploomIcon size={52}/><div><h1>{t('title')}</h1><p className="hoploom-muted">{t('subtitle')}</p></div></header>
        <div className="hoploom-card">
          <div className="hoploom-state" role="status" aria-live="polite"><span className="hoploom-dot" data-stage={stage}/>{t(stage)}</div>
          <p className="hoploom-muted">{stage === 'ready' ? t(state?.source === 'managed' ? 'managed' : 'existing') : t('automatic')}</p>
          {active && <><div className="hoploom-progress" role="progressbar" aria-label={t(stage)}><span style={{ width: progress + '%' }}/></div><p className="hoploom-muted">{t('preparing')}</p></>}
          {!active && stage !== 'ready' && <p className="hoploom-notice hoploom-muted">{t('network')}</p>}
          {error && <p className="hoploom-notice hoploom-error" role="alert">{t('failure.' + error)}</p>}
          {offline && <p className="hoploom-notice" role="alert">{t('connectionFailed')}</p>}
          <div className="hoploom-actions">
            {active ? <button disabled={busy || !state || offline} onClick={() => void action('cancel')}>{t('cancel')}</button>
              : <button className="primary" disabled={busy || offline} onClick={() => void action('prepare')}>{t(stage === 'error' ? 'retry' : 'prepare')}</button>}
            <a href="https://xiayh0107.github.io/hoploom/docs/dsh-plugin.html" target="_blank" rel="noreferrer">{t('help')}</a>
          </div>
          {notice && <p className="hoploom-notice" role="status">{t(notice)}</p>}
        </div>
        <div className="hoploom-grid">
          <div><h2>{t('inventory')}</h2><p className="hoploom-muted">{t('inventoryText')}</p></div>
          <div><h2>{t('credentials')}</h2><p className="hoploom-muted">{t('credentialsText')}</p></div>
        </div>
        <h2>{t('scope')}</h2>
        <div className="hoploom-tags"><span>{t('metadata')}</span>{state?.remoteEnabled && <span>{t('remote')}</span>}{state?.execEnabled && <span>{t('exec')}</span>}</div>
        {stage === 'ready' && <p className="hoploom-example">{t('example')}</p>}
      </div>
    </section>
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'hoploom', locale: 'dsh-hoploom' }, Panel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'hoploom', order: 25, label: () => t('title'), locale: 'dsh-hoploom',
  }, HoploomIcon))
}

export const name = 'dsh-hoploom'
export const inject = ['slots', 'locale']

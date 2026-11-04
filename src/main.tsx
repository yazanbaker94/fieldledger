import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, ChartNoAxesCombined, Check, ClipboardCheck,
  ClipboardPenLine, HardHat, Layers3, MapPin, RotateCcw, X,
} from 'lucide-react'
import { api, ApiError, type Role, type Workspace } from './api'
import { selectRetryWorkspace } from './submission-retries'
import { ForemanView, ManagerView, WorkerView, type RunMutation } from './workspace'
import './styles.css'

type View = Role | 'welcome'
type Route = { view: View; cardId: string | null }
type LoadError = { message: string; retryAt?: number }

const syncTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })

const roles = [
  { id: 'worker', label: 'Worker', icon: HardHat },
  { id: 'foreman', label: 'Foreman', icon: ClipboardCheck },
  { id: 'manager', label: 'Manager', icon: ChartNoAxesCombined },
] as const

const steps = [
  { title: 'Log the shift', detail: 'The worker submits hours on their phone and tracks the status of each timecard.', icon: ClipboardPenLine },
  { title: 'Review the work', detail: 'The foreman approves the timecard or sends it back with a note for the worker.', icon: ClipboardCheck },
  { title: 'See the cost', detail: 'The manager sees approved labour against budget and can open the timecard behind each charge.', icon: ChartNoAxesCombined },
]

function readRoute(): Route {
  const [path, query] = window.location.hash.slice(1).split('?', 2)
  const view = roles.find((role) => role.id === path)?.id ?? 'welcome'
  return { view, cardId: view === 'welcome' ? null : new URLSearchParams(query).get('card') }
}

function writeRoute(view: View, cardId: string | null, replace = false) {
  const hash = `#${view}${cardId ? `?card=${encodeURIComponent(cardId)}` : ''}`
  if (window.location.hash !== hash) {
    if (replace) window.history.replaceState(null, '', hash)
    else window.history.pushState(null, '', hash)
  }
  return { view, cardId }
}

async function openWorkspace() {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 12000)
  const load = () => api.workspace(controller.signal)
  try {
    try {
      if (navigator.locks) return await navigator.locks.request('fieldledger-open-workspace', { signal: controller.signal }, load)
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error
    }
    return await load()
  } finally {
    window.clearTimeout(timeout)
  }
}

function Brand({ onHome }: { onHome: () => void }) {
  return (
    <a className="brand" href="#welcome" onClick={(event) => { event.preventDefault(); onHome() }}>
      <span className="brand-mark"><Layers3 size={23} strokeWidth={2.3} /></span>
      <span>FieldLedger<small>Field operations</small></span>
    </a>
  )
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome page-shell">
      <section className="hero" aria-labelledby="welcome-title">
        <div className="hero-copy">
          <p className="eyebrow hero-eyebrow"><span className="signal-dot" /> Interactive construction demo</p>
          <h1 id="welcome-title">Field timecards<br className="desktop-break" /> and labour costs<span>.</span></h1>
          <p className="hero-description">Follow one timecard from a worker’s phone through foreman approval to the project’s labour budget.</p>
          <button className="button button-accent hero-cta" type="button" onClick={onStart}>
            Try the demo <ArrowRight size={18} />
          </button>
          <p className="hero-note">Three roles <span /> One shared project</p>
        </div>
        <figure className="hero-image">
          <img src="/images/riverside-roadwork.webp" alt="Crew in high-visibility gear at a fictional Ontario roadwork site" fetchPriority="high" />
          <figcaption>
            <span className="map-marker"><MapPin size={18} /></span>
            <span><strong>Riverside Road Renewal</strong><small>Ottawa, Ontario · Fictional site</small></span>
          </figcaption>
        </figure>
      </section>
      <section className="overview" aria-labelledby="overview-title">
        <div className="overview-heading">
          <div><p className="eyebrow">The workflow</p><h2 id="overview-title">How a timecard becomes a project cost</h2></div>
          <ArrowDownRight className="overview-arrow" aria-hidden="true" size={29} />
        </div>
        <div className="step-grid">
          {steps.map(({ title, detail, icon: Icon }, index) => (
            <article className="step-card" key={title}>
              <div className="step-top"><span className="step-icon"><Icon size={21} /></span><span className="eyebrow step-number">0{index + 1}</span></div>
              <h3>{title}</h3>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function ResetDialog({ busy, onClose, onReset }: { busy: boolean; onClose: () => void; onReset: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])

  return (
    <dialog ref={ref} className="reset-dialog" aria-labelledby="reset-title" onCancel={(event) => { event.preventDefault(); onClose() }}>
      <h2 id="reset-title">Start a fresh demo?</h2>
      <p>This opens a new workspace with the original timecards and labour budget.</p>
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="button button-primary" type="button" onClick={onReset} disabled={busy}>{busy ? 'Resetting…' : 'Reset workspace'}</button>
      </div>
    </dialog>
  )
}

function App() {
  const [{ view, cardId }, setRoute] = useState(readRoute)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<LoadError | null>(null)
  const [refreshError, setRefreshError] = useState(false)
  const [lastSynced, setLastSynced] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState('')
  const [notice, setNotice] = useState<{ message: string; next?: Role; cardId?: string } | null>(null)
  const [resetTarget, setResetTarget] = useState<string | null>(null)
  const writing = useRef(false)
  const activeLoad = useRef<number | null>(null)
  const initialRetryAt = useRef(0)
  const fetchVersion = useRef(0)
  const workspaceRef = useRef<Workspace | null>(null)
  const main = useRef<HTMLElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const resetTrigger = useRef<HTMLButtonElement>(null)
  const resetFocusRoute = useRef<string | null>(null)

  const go = useCallback((target: View, targetCardId?: string) => {
    setRoute(writeRoute(target, targetCardId ?? null))
    setResetTarget(null)
    setNotice(null)
    setMutationError('')
    window.scrollTo(0, 0)
    requestAnimationFrame(() => main.current?.focus({ preventScroll: true }))
  }, [])

  const selectCard = useCallback((id: string, replace = false) => {
    if (view !== 'foreman' && view !== 'manager') return
    setRoute(writeRoute(view, id, replace))
    if (!replace) {
      setNotice(null)
      setMutationError('')
    }
  }, [view])

  useEffect(() => {
    const syncRoute = () => {
      setRoute(readRoute())
      setResetTarget(null)
      setNotice(null)
      setMutationError('')
    }
    window.addEventListener('hashchange', syncRoute)
    window.addEventListener('popstate', syncRoute)
    return () => {
      window.removeEventListener('hashchange', syncRoute)
      window.removeEventListener('popstate', syncRoute)
    }
  }, [])

  const applyWorkspace = useCallback((data: Workspace) => {
    selectRetryWorkspace(data.workspaceId)
    workspaceRef.current = data
    setWorkspace(data)
    setLastSynced(new Date())
    setRefreshError(false)
  }, [])

  const loadWorkspace = useCallback(async (showLoading = true) => {
    const isInitialLoad = workspaceRef.current === null
    if (isInitialLoad && (activeLoad.current !== null || initialRetryAt.current > Date.now())) return
    const version = ++fetchVersion.current
    activeLoad.current = version
    if (showLoading) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const data = await (isInitialLoad ? openWorkspace() : api.workspace())
      if (version !== fetchVersion.current) return
      applyWorkspace(data)
      return data
    } catch (error) {
      if (version !== fetchVersion.current) return
      if (workspaceRef.current) setRefreshError(true)
      else {
        const failure = error instanceof ApiError && (error.status === 429 || error.status === 503)
          ? { message: error.message, retryAt: error.retryAt }
          : { message: 'We couldn’t open your demo workspace. Check your connection and try again.' }
        initialRetryAt.current = failure.retryAt ?? 0
        setLoadError(failure)
      }
    } finally {
      if (activeLoad.current === version) activeLoad.current = null
      if (version === fetchVersion.current) setLoading(false)
    }
  }, [applyWorkspace])

  useEffect(() => {
    if (!loadError?.retryAt) return
    const timer = window.setTimeout(() => {
      setLoadError({ message: loadError.message })
    }, Math.max(0, loadError.retryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [loadError])

  const inWorkspace = view !== 'welcome'
  useEffect(() => {
    if (inWorkspace) void loadWorkspace(!workspaceRef.current)
  }, [inWorkspace, loadWorkspace])

  useEffect(() => {
    if (!inWorkspace) return
    let frame = 0
    const refresh = () => {
      if (frame || document.visibilityState !== 'visible') return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (workspaceRef.current && !writing.current) void loadWorkspace(false)
      })
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      cancelAnimationFrame(frame)
    }
  }, [inWorkspace, loadWorkspace])

  useEffect(() => {
    if (notice || mutationError) feedback.current?.scrollIntoView({ block: 'nearest' })
    if (notice?.next) feedback.current?.querySelector<HTMLButtonElement>('[data-handoff]')?.focus({ preventScroll: true })
  }, [notice, mutationError])

  useEffect(() => {
    if (busy || resetFocusRoute.current === null) return
    if (resetFocusRoute.current === window.location.hash && document.activeElement === document.body) {
      resetTrigger.current?.focus()
    }
    resetFocusRoute.current = null
  }, [busy])

  const mutate: RunMutation = useCallback(async (operation, message, next) => {
    if (writing.current) return false
    const startingHash = window.location.hash
    const startingWorkspaceId = workspaceRef.current?.workspaceId
    writing.current = true
    fetchVersion.current += 1
    setLoading(false)
    setBusy(true)
    setMutationError('')
    setNotice(null)
    try {
      const data = await operation()
      if (!data) {
        void loadWorkspace(false)
        return false
      }
      // A queued response may describe a workspace another tab has already reset.
      const latest = await api.workspace().catch(() => null)
      const displayedId = workspaceRef.current?.workspaceId
      if (displayedId !== startingWorkspaceId && displayedId !== data.workspaceId && (!latest || latest.workspaceId === data.workspaceId)) {
        setMutationError('The demo workspace changed. You’re now viewing the current workspace.')
        return false
      }
      if (!latest) {
        setRefreshError(true)
        if (window.location.hash === startingHash) setNotice({ message: 'The change was saved. Refresh the workspace to see its current state.' })
        return true
      }
      fetchVersion.current += 1
      applyWorkspace(latest)
      if (latest.workspaceId !== data.workspaceId) {
        setMutationError('The demo workspace changed. You’re now viewing the current workspace.')
        return false
      }
      const feedback = typeof message === 'function' ? message(data) : { message, next }
      if (window.location.hash === startingHash) setNotice({ ...feedback, cardId: data.affectedCardId })
      return true
    } catch (error) {
      setMutationError(error instanceof ApiError ? error.message : 'The request didn’t finish. Try again.')
      if (error instanceof ApiError && error.status === 409) {
        const current = await loadWorkspace()
        if (current && (error.code === 'workspace_changed' || error.code === 'workspace_expired')) {
          setMutationError('The demo workspace changed. You’re now viewing the current workspace.')
        }
      } else if (!(error instanceof ApiError) || error.status >= 500) {
        void loadWorkspace(false)
      }
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }, [applyWorkspace, loadWorkspace])

  async function reset() {
    if (!resetTarget) return
    if (workspaceRef.current?.workspaceId !== resetTarget) {
      closeReset()
      setMutationError('The demo workspace changed. Open Reset demo again to confirm a fresh reset.')
      return
    }
    resetFocusRoute.current = window.location.hash
    setResetTarget(null)
    await mutate(() => api.reset(resetTarget), 'A fresh workspace is ready.')
  }

  function closeReset() {
    setResetTarget(null)
    requestAnimationFrame(() => resetTrigger.current?.focus())
  }

  const pendingCount = workspace?.timecards.filter((card) => card.status === 'pending').length ?? 0
  const roleKey = `${workspace?.workspaceId ?? ''}:${cardId ?? ''}`

  return (
    <>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus() }}>Skip to content</a>
      <header className="site-header">
        <div className="page-shell header-inner">
          <Brand onHome={() => go('welcome')} />
          <span className="demo-label"><span className="signal-dot" /> Portfolio demo</span>
        </div>
      </header>
      <main className="site-main" id="main-content" ref={main} tabIndex={-1}>
        {view === 'welcome' ? <Welcome onStart={() => go('worker')} /> : (
          <div className="workspace page-shell" aria-busy={busy || loading}>
            <div className="workspace-bar">
              <nav className="role-nav" aria-label="Demo role">
                {roles.map(({ id, label, icon: Icon }) => (
                  <a key={id} href={`#${id}`} aria-current={view === id ? 'page' : undefined} onClick={(event) => { event.preventDefault(); go(id) }}>
                    <Icon size={17} aria-hidden="true" /> {label}
                    {id === 'foreman' && pendingCount > 0 && <span className="role-count" aria-label={`${pendingCount} awaiting review`}>{pendingCount}</span>}
                  </a>
                ))}
              </nav>
              <button ref={resetTrigger} className="reset-button" type="button" onClick={() => workspace && setResetTarget(workspace.workspaceId)} disabled={busy || !workspace}>
                <RotateCcw size={15} /> <span>Reset demo</span>
              </button>
            </div>
            {notice && (
              <div className="notice" role="status" ref={feedback}>
                <Check size={19} /> <span>{notice.message}</span>
                {notice.next && <button type="button" data-handoff onClick={() => go(notice.next!, notice.cardId)}>Go to {notice.next} <ArrowRight size={15} /></button>}
                <button className="dismiss-notice" type="button" aria-label="Dismiss update" onClick={() => setNotice(null)}><X size={16} /></button>
              </div>
            )}
            {mutationError && <div className="error-message" role="alert" ref={feedback}>{mutationError}</div>}
            {refreshError && lastSynced && <div className="error-message workspace-refresh" role="status">
              <span>Couldn’t refresh the workspace. Showing data last synced at <time dateTime={lastSynced.toISOString()}>{syncTime.format(lastSynced)}</time>.</span>
              <button className="text-button" type="button" onClick={() => void loadWorkspace()} disabled={busy || loading}>Refresh workspace <RotateCcw size={15} /></button>
            </div>}
            {!workspace && (loadError ? (
              <section className="panel workspace-loading">
                <h1>Workspace unavailable</h1><p role="alert">{loadError.message}</p>
                {loadError.retryAt && <p>Try again after <time dateTime={new Date(loadError.retryAt).toISOString()}>{syncTime.format(loadError.retryAt)}</time>.</p>}
                <button className="button button-primary" type="button" onClick={() => void loadWorkspace()} disabled={loading || Boolean(loadError.retryAt)}>Try again <RotateCcw size={16} /></button>
              </section>
            ) : <p className="panel workspace-loading" role="status">Opening your workspace…</p>)}
            {workspace && view === 'worker' && <WorkerView key={roleKey} cardId={cardId} data={workspace} busy={busy} run={mutate} go={go} />}
            {workspace && view === 'foreman' && <ForemanView key={workspace.workspaceId} cardId={cardId} data={workspace} busy={busy} run={mutate} go={go} onSelectCard={selectCard} />}
            {workspace && view === 'manager' && <ManagerView key={workspace.workspaceId} cardId={cardId} data={workspace} onSelectCard={selectCard} costsStale={refreshError} />}
            {resetTarget && <ResetDialog busy={busy} onClose={closeReset} onReset={reset} />}
          </div>
        )}
      </main>
      <footer className="site-footer">
        <div className="page-shell footer-inner">
          <span><Layers3 size={16} /> FieldLedger</span>
          <span>Independent portfolio project · Fictional project data</span>
          {inWorkspace && <a href="#welcome" onClick={(event) => { event.preventDefault(); go('welcome') }}>Demo overview <ArrowUpRight size={14} /></a>}
        </div>
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

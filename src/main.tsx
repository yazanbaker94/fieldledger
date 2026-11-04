import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, ChartNoAxesCombined, Check, ClipboardCheck,
  ClipboardPenLine, HardHat, Layers3, MapPin, RotateCcw, X,
} from 'lucide-react'
import { api, ApiError, type Role, type Workspace } from './api'
import { ForemanView, ManagerView, WorkerView, type RunMutation } from './workspace'
import './styles.css'

type View = Role | 'welcome'

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

function readView(): View {
  const hash = window.location.hash.slice(1)
  return roles.find((role) => role.id === hash)?.id ?? 'welcome'
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
    <dialog ref={ref} className="reset-dialog" aria-labelledby="reset-title" onCancel={onClose}>
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
  const [view, setView] = useState<View>(readView)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState('')
  const [notice, setNotice] = useState<{ message: string; next?: Role } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const writing = useRef(false)
  const openingWorkspace = useRef(false)
  const fetchVersion = useRef(0)
  const workspaceRef = useRef<Workspace | null>(null)
  const main = useRef<HTMLElement>(null)
  const feedback = useRef<HTMLDivElement>(null)

  const go = useCallback((target: View) => {
    if (readView() !== target) window.location.hash = target
    setView(target)
    setNotice(null)
    setMutationError('')
    window.scrollTo(0, 0)
    requestAnimationFrame(() => main.current?.focus({ preventScroll: true }))
  }, [])

  useEffect(() => {
    const syncView = () => setView(readView())
    window.addEventListener('hashchange', syncView)
    return () => window.removeEventListener('hashchange', syncView)
  }, [])

  const loadWorkspace = useCallback(async (showLoading = true) => {
    const isInitialLoad = workspaceRef.current === null
    if (isInitialLoad && openingWorkspace.current) return
    if (isInitialLoad) openingWorkspace.current = true
    const version = ++fetchVersion.current
    if (showLoading) {
      setLoading(true)
      setLoadError('')
    }
    try {
      const data = await api.workspace()
      if (version !== fetchVersion.current) return
      workspaceRef.current = data
      setWorkspace(data)
    } catch {
      if (version === fetchVersion.current && !workspaceRef.current) {
        setLoadError('We couldn’t open your demo workspace. Check your connection and try again.')
      }
    } finally {
      if (isInitialLoad) openingWorkspace.current = false
      if (version === fetchVersion.current) setLoading(false)
    }
  }, [])

  const inWorkspace = view !== 'welcome'
  useEffect(() => {
    if (inWorkspace && !workspaceRef.current) void loadWorkspace()
  }, [inWorkspace, loadWorkspace])

  useEffect(() => {
    if (!inWorkspace) return
    const refresh = () => {
      if (workspaceRef.current && !writing.current) void loadWorkspace(false)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [inWorkspace, loadWorkspace])

  useEffect(() => {
    if (notice || mutationError) feedback.current?.scrollIntoView({ block: 'nearest' })
  }, [notice, mutationError])

  const mutate: RunMutation = async (operation, message, next) => {
    if (writing.current) return false
    writing.current = true
    fetchVersion.current += 1
    setLoading(false)
    setBusy(true)
    setMutationError('')
    setNotice(null)
    try {
      const data = await operation()
      workspaceRef.current = data
      setWorkspace(data)
      setNotice({ message, next })
      return true
    } catch (error) {
      setMutationError(error instanceof ApiError ? error.message : 'The request didn’t finish. Try again.')
      if (error instanceof ApiError && error.status === 409) await loadWorkspace()
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  async function reset() {
    setResetOpen(false)
    if (await mutate(api.reset, 'A fresh workspace is ready.')) setRevision((current) => current + 1)
  }

  const pendingCount = workspace?.timecards.filter((card) => card.status === 'pending').length ?? 0

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
              <button className="reset-button" type="button" onClick={() => setResetOpen(true)} disabled={busy || !workspace}>
                <RotateCcw size={15} /> <span>Reset demo</span>
              </button>
            </div>
            {notice && (
              <div className="notice" role="status" ref={feedback}>
                <Check size={19} /> <span>{notice.message}</span>
                {notice.next && <button type="button" onClick={() => go(notice.next!)}>Go to {notice.next} <ArrowRight size={15} /></button>}
                <button className="dismiss-notice" type="button" aria-label="Dismiss update" onClick={() => setNotice(null)}><X size={16} /></button>
              </div>
            )}
            {mutationError && <div className="error-message" role="alert" ref={feedback}>{mutationError}</div>}
            {!workspace && (loadError ? (
              <section className="panel workspace-loading">
                <h1>Workspace unavailable</h1><p role="alert">{loadError}</p>
                <button className="button button-primary" type="button" onClick={() => void loadWorkspace()}>Try again <RotateCcw size={16} /></button>
              </section>
            ) : <p className="panel workspace-loading" role="status">Opening your workspace…</p>)}
            {workspace && view === 'worker' && <WorkerView key={revision} data={workspace} busy={busy} run={mutate} go={go} />}
            {workspace && view === 'foreman' && <ForemanView key={revision} data={workspace} busy={busy} run={mutate} go={go} />}
            {workspace && view === 'manager' && <ManagerView key={revision} data={workspace} />}
            {resetOpen && <ResetDialog busy={busy} onClose={() => setResetOpen(false)} onReset={reset} />}
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

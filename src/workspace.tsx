import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUpRight, CalendarDays, ChartNoAxesCombined, Check, ChevronRight,
  CircleAlert, ClipboardCheck, ClipboardList, Clock3, CornerUpLeft, FileText, MapPin,
} from 'lucide-react'
import { api, type Role, type Timecard, type Workspace } from './api'

export type RunMutation = (operation: () => Promise<Workspace>, message: string, next?: Role) => Promise<boolean>

type ViewProps = {
  data: Workspace
  busy: boolean
  run: RunMutation
  go: (role: Role) => void
}

const shortDate = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
const auditDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const projectDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' })
const wholeDollars = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
const fractionalDollars = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })

function money(cents: number) {
  const formatter = cents % 100 === 0 ? wholeDollars : fractionalDollars
  return formatter.format(cents / 100)
}

function timecardCost(cents: Timecard['costCents']) {
  return cents === null ? 'Rate unavailable' : money(cents)
}

function workDate(date: string) {
  return shortDate.format(new Date(`${date}T12:00:00`))
}

function today() {
  const parts = new Map(projectDate.formatToParts().map(({ type, value }) => [type, value]))
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`
}

const statusInfo = {
  pending: { label: 'Pending', icon: Clock3 },
  returned: { label: 'Returned', icon: CornerUpLeft },
  approved: { label: 'Approved', icon: Check },
}

function Status({ status }: { status: Timecard['status'] }) {
  const { label, icon: Icon } = statusInfo[status]
  return <span className={`status-pill status-${status}`}><Icon size={13} aria-hidden="true" /> {label}</span>
}

function PageTitle({ role, title, description, data }: { role: Role; title: string; description: string; data: Workspace }) {
  const titleId = `${role}-title`
  const person = data[role].name
  const initials = person.split(' ').map((part) => part[0]).slice(0, 2).join('')
  return (
    <div className="workspace-heading">
      <div>
        <p className="eyebrow section-kicker"><span /> {role === 'manager' ? 'Project manager' : role} workspace</p>
        <h1 id={titleId}>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="persona">
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span><small>Viewing as</small><strong>{person}</strong></span>
      </div>
    </div>
  )
}

function PanelTitle({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="panel-heading"><div>{icon}<h2>{title}</h2></div>{children}</div>
}

function Empty({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="empty-state"><span className="step-icon"><ClipboardList size={23} /></span><h3>{title}</h3><p>{text}</p>{children}</div>
  )
}

function ProjectBadge({ project }: { project: Workspace['project'] }) {
  return (
    <div className="project-badge">
      <span className="project-pin"><MapPin size={20} /></span>
      <span><small>Assigned project</small><strong>{project.name}</strong><span>{project.code} · {project.location}</span></span>
    </div>
  )
}

function TimecardForm({ data, busy, run, editing, closeEdit }: Pick<ViewProps, 'data' | 'busy' | 'run'> & {
  editing: Timecard | null
  closeEdit: () => void
}) {
  const [date, setDate] = useState(() => editing?.workDate ?? today())
  const [hours, setHours] = useState(() => String(editing?.hours ?? 8))
  const attempt = useRef<{ date: string; hours: number; id: string } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const enteredHours = Number(hours)
    if (editing) {
      if (await run(() => api.resubmit(editing, date, enteredHours), 'Timecard resubmitted for review.', 'foreman')) closeEdit()
      return
    }

    if (attempt.current?.date !== date || attempt.current.hours !== enteredHours) {
      attempt.current = { date, hours: enteredHours, id: crypto.randomUUID() }
    }
    const requestId = attempt.current.id
    if (await run(() => api.submit(date, enteredHours, requestId), 'Timecard submitted for review.', 'foreman')) attempt.current = null
  }

  return (
    <section className="panel log-panel" aria-label={editing ? 'Correct timecard' : 'New timecard'}>
      <PanelTitle icon={<FileText size={20} />} title={editing ? 'Correct timecard' : 'New timecard'} />
      <div className="panel-body">
        <ProjectBadge project={data.project} />
        {editing?.reason && <div className="correction-callout"><CornerUpLeft size={18} /><div><strong>Foreman’s correction note</strong><p>{editing.reason}</p></div></div>}
        <form onSubmit={submit}>
          <div className="form-fields">
            <label htmlFor="work-date">Work date
              <input id="work-date" type="date" value={date} max={today()} required onChange={(event) => setDate(event.target.value)} disabled={busy} />
            </label>
            <label htmlFor="hours-worked">Hours worked
              <span className="input-suffix">
                <input id="hours-worked" type="number" inputMode="decimal" min="0.01" max="24" step="0.01" value={hours} required onChange={(event) => setHours(event.target.value)} disabled={busy} />
                <span aria-hidden="true">hrs</span>
              </span>
            </label>
          </div>
          <p className="field-help">Log regular hours worked on this project.</p>
          <div className="form-actions">
            {editing && <button className="button button-secondary" type="button" onClick={closeEdit} disabled={busy}>Cancel</button>}
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Resubmit timecard' : 'Submit timecard'} <ArrowRight size={17} />
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

const auditLabels = { submitted: 'Submitted', returned: 'Returned for correction', resubmitted: 'Resubmitted', approved: 'Approved' }

function Audit({ card }: { card: Timecard }) {
  return (
    <div className="audit">
      <h3>Activity</h3>
      <ol>
        {card.audit.map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <span className={`audit-dot ${event.action === 'approved' ? 'audit-dot-approved' : ''}`} />
            <div><strong>{auditLabels[event.action]}</strong><p>{event.actor} · <time dateTime={event.at}>{auditDate.format(new Date(event.at))}</time></p>{event.note && <p className="audit-note">{event.note}</p>}</div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CardSummary({ card, showCost }: { card: Timecard; showCost: boolean }) {
  return (
    <>
      <div className="card-summary-header">
        <div><p className="eyebrow">Timecard</p><h3>{card.workerName}</h3></div>
        <Status status={card.status} />
      </div>
      <dl className={`card-facts${showCost ? ' has-cost' : ''}`}>
        <div><dt>Work date</dt><dd>{workDate(card.workDate)}</dd></div>
        <div><dt>Hours worked</dt><dd>{card.hours} hrs</dd></div>
        {showCost && <div><dt>{card.status === 'approved' ? 'Approved cost' : 'Est. cost'}</dt><dd>{timecardCost(card.costCents)}</dd></div>}
      </dl>
    </>
  )
}

function CardRow({ card, showCost, selected, onClick }: { card: Timecard; showCost?: boolean; selected: boolean; onClick: () => void }) {
  return (
    <button className={`card-row${selected ? ' card-row-selected' : ''}${showCost ? ' card-row-cost' : ''}`} type="button" onClick={onClick} aria-expanded={selected}>
      <span className="sr-only">View timecard for </span>
      <span className="card-row-icon"><CalendarDays size={17} /></span>
      <span className="card-row-title"><strong>{workDate(card.workDate)}</strong><small>{card.workerName} · {card.hours} hrs</small></span>
      <Status status={card.status} />
      {showCost && <strong className="row-cost">{timecardCost(card.costCents)}</strong>}
      <ChevronRight className="row-chevron" size={17} aria-hidden="true" />
    </button>
  )
}

export function WorkerView({ data, busy, run, go }: ViewProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const formArea = useRef<HTMLDivElement>(null)
  const ownCards = data.timecards.filter((card) => card.workerName === data.worker.name)
  const editing = ownCards.find((card) => card.id === editingId && card.status === 'returned') ?? null
  const sortedCards = [...ownCards].sort((first, second) => Number(second.status === 'returned') - Number(first.status === 'returned'))

  function edit(card: Timecard) {
    setEditingId(card.id)
    requestAnimationFrame(() => {
      formArea.current?.scrollIntoView({ block: 'nearest' })
      formArea.current?.querySelector<HTMLInputElement>('#work-date')?.focus({ preventScroll: true })
    })
  }

  return (
    <section aria-labelledby="worker-title">
      <PageTitle role="worker" title="Log a timecard" description="Record a shift and follow its status from submission to approval." data={data} />
      <div className="content-grid worker-grid">
        <div className="view-stack" ref={formArea}>
          <TimecardForm key={editing?.id ?? 'new'} data={data} busy={busy} run={run} editing={editing} closeEdit={() => setEditingId(null)} />
          <aside className="next-step"><span className="step-icon"><ClipboardCheck size={20} /></span><div><h3>What happens next?</h3><p>Your foreman sees the timecard in their review queue.</p></div><button className="text-button" type="button" onClick={() => go('foreman')}>Open foreman view <ArrowUpRight size={15} /></button></aside>
        </div>
        <section className="panel" aria-label="My timecards">
          <PanelTitle icon={<Clock3 size={20} />} title="My timecards"><span className="count-pill">{ownCards.length}</span></PanelTitle>
          {sortedCards.length ? <div className="card-list">
            {sortedCards.map((card) => (
              <div className="card-list-item" key={card.id}>
                <CardRow card={card} selected={openId === card.id} onClick={() => setOpenId((previous) => previous === card.id ? null : card.id)} />
                {card.status === 'returned' && <div className="row-correction"><p>{card.reason}</p><button className="text-button" type="button" onClick={() => edit(card)} disabled={busy || editingId === card.id}>Correct and resubmit <ArrowUpRight size={14} /></button></div>}
                {openId === card.id && <div className="inline-details"><Audit card={card} /></div>}
              </div>
            ))}
          </div> : <Empty title="No timecards yet" text="Your submitted timecards will appear here." />}
        </section>
      </div>
    </section>
  )
}

function ForemanDecision({ card, busy, run, complete }: { card: Timecard; busy: boolean; run: RunMutation; complete: () => void }) {
  const [returning, setReturning] = useState(false)
  const [reason, setReason] = useState('')
  const note = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { if (returning) note.current?.focus() }, [returning])

  async function decide(decision: 'approve' | 'return') {
    const isApproval = decision === 'approve'
    if (await run(() => api.decide(card, decision, isApproval ? undefined : reason.trim()),
      isApproval ? 'Timecard approved.' : 'Timecard returned to the worker.', isApproval ? 'manager' : 'worker')) {
      setReturning(false)
      setReason('')
      complete()
    }
  }

  if (card.status !== 'pending') return null

  return returning ? (
    <form className="return-form" onSubmit={(event) => { event.preventDefault(); void decide('return') }}>
      <label htmlFor="correction-note">Correction note</label>
      <textarea ref={note} id="correction-note" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={300} rows={3} placeholder="Tell the worker what to change…" disabled={busy} />
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={() => setReturning(false)} disabled={busy}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={busy || !reason.trim()}><CornerUpLeft size={16} /> Send back to worker</button>
      </div>
    </form>
  ) : (
    <div className="form-actions decision-actions">
      <button className="button button-secondary" type="button" onClick={() => setReturning(true)} disabled={busy}><CornerUpLeft size={16} /> Return with a note</button>
      <button className="button button-primary" type="button" onClick={() => void decide('approve')} disabled={busy}><Check size={17} /> Approve timecard</button>
    </div>
  )
}

export function ForemanView({ data, busy, run, go }: ViewProps) {
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const pending = data.timecards.filter((card) => card.status === 'pending')
  const shown = filter === 'pending' ? pending : data.timecards
  const selected = shown.find((card) => card.id === selectedId) ?? shown[0]
  const review = useRef<HTMLElement>(null)

  function select(card: Timecard) {
    setSelectedId(card.id)
    if (window.matchMedia('(max-width: 800px)').matches) {
      review.current?.scrollIntoView({ block: 'start' })
      review.current?.focus({ preventScroll: true })
    }
  }

  return (
    <section aria-labelledby="foreman-title">
      <PageTitle role="foreman" title="Review timecards" description="Check hours for the project, approve the work, or send an entry back with a note." data={data} />
      <div className="content-grid foreman-grid">
        <section className="panel" aria-label="Review queue">
          <PanelTitle icon={<ClipboardList size={20} />} title="Review queue"><span className="count-pill">{pending.length} pending</span></PanelTitle>
          <div className="filter-group" role="group" aria-label="Filter review queue">
            <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Pending</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
          </div>
          {shown.length ? <div className="card-list">
            {shown.map((card) => <div className="card-list-item" key={card.id}><CardRow card={card} selected={selected?.id === card.id} onClick={() => select(card)} /></div>)}
          </div> : (
            <Empty title="You’re caught up" text="New submissions and corrected timecards will appear here.">
              <button className="text-button" type="button" onClick={() => go('worker')}>Open worker view <ArrowUpRight size={15} /></button>
            </Empty>
          )}
        </section>
        <section className="panel review-panel" aria-label="Timecard review" ref={review} tabIndex={-1}>
          <PanelTitle icon={<FileText size={20} />} title="Timecard review" />
          {selected ? <div className="panel-body">
            <CardSummary card={selected} showCost />
            <ForemanDecision key={selected.id} card={selected} busy={busy} run={run} complete={() => { setSelectedId(selected.id); setFilter('all') }} />
            <Audit card={selected} />
          </div> : <Empty title="No timecard selected" text="Open a timecard from the queue to see its hours and activity." />}
        </section>
      </div>
    </section>
  )
}

function Budget({ project }: { project: Workspace['project'] }) {
  const balance = project.budgetCents - project.approvedCents
  const overBudget = balance < 0
  const used = project.budgetCents ? project.approvedCents / project.budgetCents * 100 : 0
  const percentage = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 1 }).format(used)
  return (
    <section className="panel budget-panel" aria-label="Project labour budget">
      <div className="budget-header">
        <div><p className="eyebrow"><span className="signal-dot" /> Live project costs</p><h2>{project.name}</h2><p><MapPin size={15} /> {project.location} <span className="budget-divider" /> {project.code}</p></div>
        <span className={`budget-state${overBudget ? ' budget-state-over' : ''}`}>{overBudget ? <CircleAlert size={16} /> : <Check size={16} />} {overBudget ? 'Over budget' : 'Within budget'}</span>
      </div>
      <div className="budget-metrics">
        <div><span>Approved labour</span><output id="approved-total" aria-label="Approved labour">{money(project.approvedCents)}</output></div>
        <div><span>Labour budget</span><strong>{money(project.budgetCents)}</strong></div>
        <div><span>Pending labour estimate</span><strong>{money(project.pendingCents)}</strong></div>
      </div>
      <div className="budget-progress">
        <div><strong>{percentage}% of labour budget used</strong><span className={overBudget ? 'over-amount' : ''}>{money(Math.abs(balance))} {overBudget ? 'over budget' : 'remaining'}</span></div>
        <progress className={overBudget ? 'over-progress' : ''} max={100} value={Math.min(used, 100)} aria-label={`${percentage}% of labour budget used`} />
      </div>
    </section>
  )
}

export function ManagerView({ data }: { data: Workspace }) {
  const [filter, setFilter] = useState<'approved' | 'all'>('approved')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const detail = useRef<HTMLElement>(null)
  const approved = data.timecards.filter((card) => card.status === 'approved')
  const shown = filter === 'approved' ? approved : data.timecards
  const selected = shown.find((card) => card.id === selectedId)

  function select(card: Timecard) {
    setSelectedId(card.id)
    if (window.matchMedia('(max-width: 800px)').matches) {
      detail.current?.scrollIntoView({ block: 'start' })
      detail.current?.focus({ preventScroll: true })
    }
  }

  return (
    <section aria-labelledby="manager-title">
      <PageTitle role="manager" title="Labour budget" description="Compare approved hours against the project’s labour budget and open the timecards behind the total." data={data} />
      <Budget project={data.project} />
      <div className="content-grid manager-grid">
        <section className="panel" aria-label="Timecard ledger">
          <PanelTitle icon={<ClipboardList size={20} />} title="Timecard ledger"><span className="count-pill">CAD</span></PanelTitle>
          <div className="filter-group" role="group" aria-label="Filter timecard ledger">
            <button type="button" aria-pressed={filter === 'approved'} onClick={() => setFilter('approved')}>Approved</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
          </div>
          {shown.length ? <div className="card-list">
            {shown.map((card) => <div className="card-list-item" key={card.id}><CardRow card={card} showCost selected={selectedId === card.id} onClick={() => select(card)} /></div>)}
          </div> : <Empty title="No timecards to show" text="Approved timecards will appear in the project ledger." />}
        </section>
        <section className="panel review-panel" aria-label="Cost details" ref={detail} tabIndex={-1}>
          <PanelTitle icon={<ChartNoAxesCombined size={20} />} title="Cost details" />
          {selected ? <div className="panel-body"><CardSummary card={selected} showCost /><Audit card={selected} /></div>
            : <Empty title="Open a timecard" text="See its recorded hours, labour cost, and approval history." />}
        </section>
      </div>
      <p className="budget-footnote"><ArrowDown size={15} /> Pending submissions appear as an estimate until the foreman approves them.</p>
    </section>
  )
}

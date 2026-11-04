import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, ChartNoAxesCombined, Check, ChevronRight,
  CircleAlert, ClipboardCheck, ClipboardList, Clock3, CornerUpLeft, FileText, MapPin,
} from 'lucide-react'
import { hasVisibleNote } from '../server/note'
import { api, ApiError, type Role, type Timecard, type Workspace } from './api'
import { confirmAttempt, hasAttempt, latestAttempt, latestSubmissionAttempt, onSubmissionAttemptsChanged, rememberAttempt, type SubmissionAttempt } from './submission-retries'

export type RunMutation = (operation: () => Promise<Workspace | null>, message: string | ((data: Workspace) => { message: string; next?: Role }), next?: Role) => Promise<boolean>

type ViewProps = {
  cardId: string | null
  data: Workspace
  busy: boolean
  writesBlocked?: boolean
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

function TimecardForm({ data, busy, writesBlocked, run, editing, currentCard, closeEdit, retryDraft, setRetryDraft, checkRetry, discardRetry }: Pick<ViewProps, 'data' | 'busy' | 'writesBlocked' | 'run'> & {
  editing: Timecard | null
  currentCard?: Timecard
  closeEdit: () => void
  retryDraft?: SubmissionAttempt
  setRetryDraft: (attempt: SubmissionAttempt | undefined, requestId: string) => void
  checkRetry: (attempt: SubmissionAttempt) => void
  discardRetry: (attempt: SubmissionAttempt) => void
}) {
  const [date, setDate] = useState(() => retryDraft?.workDate ?? editing?.workDate ?? today())
  const [hours, setHours] = useState(() => String(retryDraft?.hours ?? editing?.hours ?? 8))
  const [version, setVersion] = useState(() => retryDraft?.correction?.version ?? editing?.version)
  const [previousDraft, setPreviousDraft] = useState<{ date: string; hours: string }>()
  const dateField = useRef<HTMLInputElement>(null)
  const unavailable = editing !== null && currentCard?.status !== 'returned'
  const stale = currentCard?.status === 'returned' && currentCard.version !== version
  const note = currentCard?.reason ?? editing?.reason
  const matchingRetry = retryDraft?.workDate === date && retryDraft.hours === Number(hours) ? retryDraft : undefined
  const changedSubmission = !editing && Boolean(retryDraft && !matchingRetry)

  function restoreSubmission(attempt: SubmissionAttempt) {
    setDate(attempt.workDate)
    setHours(String(attempt.hours))
    requestAnimationFrame(() => dateField.current?.focus())
  }

  function reviewLatest() {
    if (!currentCard || currentCard.status !== 'returned') return
    setPreviousDraft({ date, hours })
    setDate(currentCard.workDate)
    setHours(String(currentCard.hours))
    setVersion(currentCard.version)
    if (retryDraft?.correction && retryDraft.correction.version !== currentCard.version) {
      void confirmAttempt(data.workspaceId, retryDraft)
      setRetryDraft(undefined, retryDraft.requestId)
    }
    requestAnimationFrame(() => dateField.current?.focus())
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || writesBlocked || stale || unavailable || changedSubmission) return
    const enteredHours = Number(hours)
    const workspaceId = data.workspaceId
    const correction = editing && version !== undefined ? { cardId: editing.id, version } : undefined
    const unconfirmed = correction ? undefined : latestSubmissionAttempt(workspaceId)
    let attempt: SubmissionAttempt | undefined
    const saved = await run(async () => {
      const reserved = await rememberAttempt(workspaceId, date, enteredHours, correction, retryDraft?.requestId ?? unconfirmed?.requestId)
      if (!reserved) {
        setRetryDraft(undefined, retryDraft?.requestId ?? '')
        throw new ApiError('The pending submission changed in another tab. Review the current timecard list before trying again.', 409)
      }
      attempt = reserved
      const { requestId } = reserved
      try {
        return correction
          ? await api.resubmit(workspaceId, correction.cardId, correction.version, date, enteredHours, requestId)
          : await api.submit(workspaceId, date, enteredHours, requestId)
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          await confirmAttempt(workspaceId, reserved)
          setRetryDraft(undefined, requestId)
        } else if (!correction && !hasAttempt(workspaceId, requestId)) {
          const recovered = await api.findSubmission(workspaceId, requestId).catch(() => null)
          if (recovered) return recovered
        }
        throw error
      }
    }, correction ? 'Timecard resubmitted for review.' : 'Timecard submitted for review.', 'foreman')
    if (!attempt) return
    const { requestId } = attempt
    if (saved) {
      await confirmAttempt(workspaceId, attempt)
      setRetryDraft(undefined, requestId)
      if (correction) closeEdit()
    } else if (hasAttempt(workspaceId, requestId)) {
      setRetryDraft(attempt, requestId)
    }
  }

  return (
    <section className="panel log-panel" aria-label={editing ? 'Correct timecard' : 'New timecard'}>
      <PanelTitle icon={<FileText size={20} />} title={editing ? 'Correct timecard' : 'New timecard'} />
      <div className="panel-body">
        <ProjectBadge project={data.project} />
        {note && <div className="correction-callout"><CornerUpLeft size={18} /><div><strong>Foreman’s correction note</strong><p>{note}</p></div></div>}
        {stale && currentCard && (
          <div className="draft-conflict" role="alert">
            <strong>Timecard changed while you were editing.</strong>
            <p>Latest saved entry: {currentCard.hours} hrs · {workDate(currentCard.workDate)}. Your draft is still in the form below.</p>
            <button className="text-button" type="button" onClick={reviewLatest} disabled={busy}>Review latest timecard <ArrowRight size={15} /></button>
          </div>
        )}
        {unavailable && (
          <div className="draft-conflict" role="status">
            <strong>This timecard is no longer available for correction.</strong>
            <p>{currentCard && `Current status: ${statusInfo[currentCard.status].label}. `}Your draft is still shown below.</p>
          </div>
        )}
        <form onSubmit={submit}>
          <div className="form-fields">
            <label htmlFor="work-date">Work date
              <input ref={dateField} id="work-date" type="date" value={date} min="2000-01-01" max={today()} required onChange={(event) => setDate(event.target.value)} disabled={busy || stale || unavailable} />
            </label>
            <label htmlFor="hours-worked">Hours worked
              <span className="input-suffix">
                <input id="hours-worked" type="number" inputMode="decimal" min="0.01" max="24" step="0.01" value={hours} required onChange={(event) => setHours(event.target.value)} disabled={busy || stale || unavailable} />
                <span aria-hidden="true">hrs</span>
              </span>
            </label>
          </div>
          <p className="field-help">Log regular hours worked on this project.</p>
          {previousDraft && <p className="field-help">Previous draft: {previousDraft.hours ? `${previousDraft.hours} hrs` : 'Hours unset'}{previousDraft.date && ` · ${workDate(previousDraft.date)}`}</p>}
          {retryDraft && !editing && (
            <div className="draft-conflict" role="status">
              <strong>An earlier submission is still unconfirmed.</strong>
              <p>Original entry: {retryDraft.hours} hrs · {workDate(retryDraft.workDate)}</p>
              <p>{changedSubmission ? 'Check whether it saved or restore the original details before retrying.' : 'Check whether it saved or retry with these details.'}</p>
              <button className="text-button" type="button" onClick={() => checkRetry(retryDraft)} disabled={busy || writesBlocked}>Check saved submission <ArrowRight size={15} /></button>
              {changedSubmission && <button className="text-button" type="button" onClick={() => restoreSubmission(retryDraft)} disabled={busy}>Restore original details <ArrowRight size={15} /></button>}
              <button className="text-button" type="button" onClick={() => discardRetry(retryDraft)} disabled={busy || writesBlocked}>Discard unsaved attempt <ArrowRight size={15} /></button>
            </div>
          )}
          {matchingRetry?.correction && <p className="field-help retry-help">An earlier correction is still unconfirmed.{!stale && !unavailable && ' Submit these same details to check or finish saving it.'}</p>}
          <div className="form-actions">
            {matchingRetry?.correction && (stale || unavailable) && <button className="button button-secondary" type="button" onClick={() => checkRetry(matchingRetry)} disabled={busy || writesBlocked}>Check saved correction</button>}
            {editing && <button className="button button-secondary" type="button" onClick={closeEdit} disabled={busy}>Cancel</button>}
            <button className="button button-primary" type="submit" disabled={busy || writesBlocked || stale || unavailable || changedSubmission}>
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
            <div>
              <strong>{auditLabels[event.action]}</strong>
              <p>{event.actor} · <time dateTime={event.at}>{auditDate.format(new Date(event.at))}</time></p>
              {event.previousWorkDate && typeof event.previousHours === 'number' && <p className="audit-entry">Previous entry: {event.previousHours} hrs · {workDate(event.previousWorkDate)}</p>}
              {event.workDate && typeof event.hours === 'number' && <p className="audit-entry">{event.action === 'resubmitted' ? 'Updated entry' : 'Entry'}: {event.hours} hrs · {workDate(event.workDate)}</p>}
              {event.note && <p className="audit-note">{event.note}</p>}
            </div>
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
      {showCost && typeof card.rateCents === 'number' && (
        <p className="cost-calculation">
          <span>{card.status === 'approved' ? 'Applied labour rate' : 'Estimated labour rate'}</span>
          <strong>{card.hours} hrs × {money(card.rateCents)}/hr</strong>
        </p>
      )}
    </>
  )
}

function CardRow({ card, showCost, selected, controls, onClick }: { card: Timecard; showCost?: boolean; selected: boolean; controls?: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button className={`card-row${selected ? ' card-row-selected' : ''}${showCost ? ' card-row-cost' : ''}`} type="button" onClick={onClick}
      data-card-id={card.id} aria-expanded={selected} aria-controls={controls}>
      <span className="sr-only">View timecard for </span>
      <span className="card-row-icon"><CalendarDays size={17} /></span>
      <span className="card-row-title"><strong>{workDate(card.workDate)}</strong><small>{card.workerName} · {card.hours} hrs</small></span>
      <Status status={card.status} />
      {showCost && <strong className="row-cost">{timecardCost(card.costCents)}</strong>}
      <ChevronRight className="row-chevron" size={17} aria-hidden="true" />
    </button>
  )
}

function focusDetails(detail: HTMLElement | null, event?: MouseEvent<HTMLButtonElement>) {
  const mobile = window.matchMedia('(max-width: 800px)').matches
  if (!mobile && event && event.detail !== 0) return
  detail?.scrollIntoView({ block: mobile ? 'start' : 'nearest' })
  detail?.focus({ preventScroll: true })
}

function focusLedger(ledger: HTMLElement | null, cardId?: string) {
  const row = cardId && ledger?.querySelector<HTMLButtonElement>(`[data-card-id="${CSS.escape(cardId)}"]`)
  if (row) row.focus()
  else ledger?.focus()
}

export function WorkerView({ cardId, data, busy, writesBlocked, run, go }: ViewProps) {
  const ownCards = data.timecards.filter((card) => card.workerName === data.worker.name)
  const linkedCard = ownCards.find((card) => card.id === cardId)
  const [opening] = useState(() => {
    const attempt = latestAttempt(data.workspaceId, cardId ?? undefined) ?? latestSubmissionAttempt(data.workspaceId)
    const retryCard = ownCards.find((card) => card.id === attempt?.correction?.cardId)
    return { editor: linkedCard?.status === 'returned' ? linkedCard : retryCard ?? null, attempt }
  })
  const [editing, setEditing] = useState(opening.editor)
  const [openId, setOpenId] = useState<string | null>(null)
  const [correctionRetry, setCorrectionRetry] = useState(() => opening.attempt?.correction ? opening.attempt : undefined)
  const [submissionRetry, setSubmissionRetry] = useState(() => latestSubmissionAttempt(data.workspaceId))
  const formArea = useRef<HTMLDivElement>(null)
  const currentCard = ownCards.find((card) => card.id === editing?.id)
  const retryDraft = editing
    ? correctionRetry?.correction?.cardId === editing.id ? correctionRetry : undefined
    : submissionRetry
  const formRetry = retryDraft && hasAttempt(data.workspaceId, retryDraft.requestId) ? retryDraft : undefined
  const sortedCards = [...ownCards].sort((first, second) => Number(second.status === 'returned') - Number(first.status === 'returned'))
  const primaryCorrection = sortedCards.find((card) => card.status === 'returned')

  const updateRetryDraft = useCallback((attempt: SubmissionAttempt | undefined, requestId: string) => {
    setCorrectionRetry((draft) => attempt?.correction ? attempt : draft?.requestId === requestId ? undefined : draft)
    setSubmissionRetry(latestSubmissionAttempt(data.workspaceId))
  }, [data.workspaceId])

  const recover = useCallback(async (attempt: SubmissionAttempt, showError = false) => {
    const { requestId, correction } = attempt
    const workspaceId = data.workspaceId
    const saved = await run(async () => {
      try {
        return await api.findSubmission(workspaceId, requestId)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'submission_discarded') {
          await confirmAttempt(workspaceId, attempt)
          updateRetryDraft(undefined, requestId)
          if (showError) throw error
          return null
        }
        if (error instanceof ApiError && error.status === 409) throw error
        if (showError) throw new ApiError(correction
          ? 'We couldn’t confirm that this correction was saved.'
          : 'We couldn’t confirm that this submission was saved. Retry with the original details. You can also discard the unsaved attempt.', 400)
        return null
      }
    }, correction ? 'Recovered your resubmitted timecard.' : 'Recovered your submitted timecard.', 'foreman')

    if (saved) {
      await confirmAttempt(workspaceId, attempt)
      updateRetryDraft(undefined, requestId)
      if (correction) setEditing((editor) => editor?.id === correction.cardId ? null : editor)
    }
  }, [data.workspaceId, run, updateRetryDraft])

  async function discard(attempt: SubmissionAttempt) {
    const workspaceId = data.workspaceId
    const resolved = await run(() => api.discardSubmission(workspaceId, attempt.requestId), (result) => result.affectedCardId
      ? { message: 'This timecard already saved.', next: 'foreman' }
      : { message: 'Unsaved submission discarded. You can submit updated details.' })
    if (!resolved) return
    await confirmAttempt(workspaceId, attempt)
    updateRetryDraft(undefined, attempt.requestId)
  }

  useEffect(() => {
    if (opening.attempt && hasAttempt(data.workspaceId, opening.attempt.requestId)) void recover(opening.attempt)
  }, [data.workspaceId, opening, recover])

  useEffect(() => {
    const checkPending = () => {
      if (document.visibilityState !== 'visible') return
      setSubmissionRetry(latestSubmissionAttempt(data.workspaceId))
      const attempt = latestAttempt(data.workspaceId, cardId ?? editing?.id) ?? latestSubmissionAttempt(data.workspaceId)
      if (attempt) void recover(attempt)
    }
    window.addEventListener('focus', checkPending)
    document.addEventListener('visibilitychange', checkPending)
    return () => {
      window.removeEventListener('focus', checkPending)
      document.removeEventListener('visibilitychange', checkPending)
    }
  }, [cardId, data.workspaceId, editing?.id, recover])

  useEffect(() => onSubmissionAttemptsChanged(data.workspaceId, (removed) => {
    const latest = latestSubmissionAttempt(data.workspaceId)
    setSubmissionRetry(latest)
    if (!latest && !editing && !cardId && removed && submissionRetry?.requestId === removed.requestId) void recover(removed)
  }), [cardId, data.workspaceId, editing, recover, submissionRetry])

  function edit(card: Timecard) {
    setEditing(card)
    setCorrectionRetry(latestAttempt(data.workspaceId, card.id))
    requestAnimationFrame(() => {
      formArea.current?.scrollIntoView({ block: 'nearest' })
      formArea.current?.querySelector<HTMLInputElement>('#work-date')?.focus({ preventScroll: true })
    })
  }

  function closeEdit() {
    setEditing(null)
    requestAnimationFrame(() => {
      if (editing && document.activeElement === document.body) {
        const trigger = document.querySelector<HTMLButtonElement>(`[data-correct-card="${CSS.escape(editing.id)}"]`)
        if (trigger) trigger.focus()
        else formArea.current?.querySelector<HTMLElement>('[data-open-timecard-form], #work-date')?.focus()
      }
    })
  }

  return (
    <section aria-labelledby="worker-title">
      <PageTitle role="worker" title="Log a timecard" description="Record a shift and follow its status from submission to approval." data={data} />
      <div className="content-grid worker-grid">
        <div className="view-stack" ref={formArea}>
          {primaryCorrection && !editing && !cardId && (
            <aside className="correction-action" aria-labelledby="correction-title">
              <span className="step-icon"><CornerUpLeft size={20} /></span>
              <div><h2 id="correction-title">Action needed</h2><p><strong>{workDate(primaryCorrection.workDate)}</strong> · {primaryCorrection.reason}</p></div>
              <button className="text-button" type="button" data-correct-card={primaryCorrection.id} onClick={() => edit(primaryCorrection)} disabled={busy}>Correct and resubmit <ArrowUpRight size={14} /></button>
            </aside>
          )}
          {cardId && !editing ? (
            <section className="panel log-panel" aria-label="Linked timecard">
              <PanelTitle icon={<FileText size={20} />} title="Linked timecard" />
              <div className="panel-body">
                {linkedCard ? <><CardSummary card={linkedCard} showCost={false} /><Audit card={linkedCard} /></>
                  : <p role="status">This timecard is unavailable in your current workspace.</p>}
                <div className="form-actions">
                  {linkedCard?.status === 'returned' && <button className="button button-secondary" type="button" data-correct-card={linkedCard.id} onClick={() => edit(linkedCard)} disabled={busy}>Correct and resubmit</button>}
                  <button className="button button-primary" type="button" data-open-timecard-form onClick={() => go('worker')} disabled={busy}>Open new timecard form <ArrowRight size={17} /></button>
                </div>
              </div>
            </section>
          ) : (
            <TimecardForm key={editing?.id ?? 'new'} data={data} busy={busy} writesBlocked={writesBlocked} run={run} editing={editing} currentCard={currentCard} closeEdit={closeEdit} retryDraft={formRetry}
              setRetryDraft={updateRetryDraft}
              checkRetry={(attempt) => void recover(attempt, true)} discardRetry={(attempt) => void discard(attempt)} />
          )}
          {!cardId && <aside className="next-step"><span className="step-icon"><ClipboardCheck size={20} /></span><div><h3>What happens next?</h3><p>Your foreman sees the timecard in their review queue.</p></div><button className="text-button" type="button" onClick={() => go('foreman')}>Open foreman view <ArrowUpRight size={15} /></button></aside>}
        </div>
        <section className="panel" aria-label="My timecards">
          <PanelTitle icon={<Clock3 size={20} />} title="My timecards"><span className="count-pill">{ownCards.length}</span></PanelTitle>
          {sortedCards.length ? <div className="card-list">
            {sortedCards.map((card) => (
              <div className="card-list-item" key={card.id}>
                <CardRow card={card} selected={openId === card.id} onClick={() => setOpenId((previous) => previous === card.id ? null : card.id)} />
                {!cardId && card.status === 'returned' && card.id !== primaryCorrection?.id && <div className="row-correction"><p>{card.reason}</p><button className="text-button" type="button" data-correct-card={card.id} onClick={() => edit(card)} disabled={busy || editing?.id === card.id}>Correct and resubmit <ArrowUpRight size={14} /></button></div>}
                {openId === card.id && <div className="inline-details"><Audit card={card} /></div>}
              </div>
            ))}
          </div> : <Empty title="No timecards yet" text="Your submitted timecards will appear here." />}
        </section>
      </div>
    </section>
  )
}

function ForemanDecision({ workspaceId, card, busy, writesBlocked, run, complete }: { workspaceId: string; card: Timecard; busy: boolean; writesBlocked?: boolean; run: RunMutation; complete: () => void }) {
  const [reviewedVersion, setReviewedVersion] = useState(card.version)
  const [returnVersion, setReturnVersion] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const note = useRef<HTMLTextAreaElement>(null)
  const returnButton = useRef<HTMLButtonElement>(null)
  const reviewButton = useRef<HTMLButtonElement>(null)
  const returning = returnVersion !== null
  const pending = card.status === 'pending'
  const canReturn = card.canReturn !== false
  const stale = (returnVersion ?? reviewedVersion) !== card.version
  const validReason = hasVisibleNote(reason)
  const invisibleReason = reason.length > 0 && !validReason

  useEffect(() => {
    if (returning) note.current?.focus()
  }, [returning])

  async function decide(decision: 'approve' | 'return') {
    const isApproval = decision === 'approve'
    const version = isApproval ? reviewedVersion : returnVersion
    if (busy || writesBlocked || !pending || version !== card.version || (!isApproval && (!canReturn || !validReason))) return
    if (await run(() => api.decide(workspaceId, card.id, version, decision, isApproval ? undefined : reason.trim()),
      isApproval ? 'Timecard approved.' : 'Timecard returned to the worker.', isApproval ? 'manager' : 'worker')) {
      setReturnVersion(null)
      setReason('')
      complete()
    }
  }

  function reviewLatest(event: MouseEvent<HTMLButtonElement>) {
    const detail = event.currentTarget.closest<HTMLElement>('#timecard-review')
    setReviewedVersion(card.version)
    if (returning) setReturnVersion(card.version)
    requestAnimationFrame(() => (returning ? note.current : detail)?.focus())
  }

  function cancel() {
    const detail = note.current?.closest<HTMLElement>('#timecard-review')
    setReturnVersion(null)
    setReason('')
    requestAnimationFrame(() => {
      if (returnButton.current?.disabled === false) returnButton.current.focus()
      else if (reviewButton.current?.disabled === false) reviewButton.current.focus()
      else detail?.focus()
    })
  }

  if (!pending && !returning) return <p className="read-only-detail">This timecard is no longer pending.</p>

  return returning ? (
    <form className="return-form" onSubmit={(event) => { event.preventDefault(); void decide('return') }}>
      {!pending && <div className="draft-conflict" role="status"><strong>This timecard is no longer pending.</strong><p>Your note is shown below.</p></div>}
      {pending && stale && (
        <div className="draft-conflict" role="alert">
          <strong>Timecard changed while you were writing this note.</strong>
          <p>Review the latest hours and work date above. Your note is still in the form below.</p>
          <button className="text-button" type="button" onClick={reviewLatest} disabled={busy}>Review latest timecard <ArrowRight size={15} /></button>
        </div>
      )}
      <label htmlFor="correction-note">Correction note</label>
      <textarea ref={note} id="correction-note" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={300} rows={3} placeholder="Tell the worker what to change…" disabled={busy} readOnly={!pending || stale || !canReturn}
        aria-invalid={invisibleReason || undefined} aria-describedby={invisibleReason ? 'correction-note-help' : undefined} />
      {invisibleReason && <p className="field-help" id="correction-note-help">Include a visible correction note.</p>}
      {pending && !canReturn && <p className="field-help">This timecard has reached its correction limit. It can still be approved.</p>}
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={cancel} disabled={busy}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={busy || writesBlocked || !pending || stale || !canReturn || !validReason}><CornerUpLeft size={16} /> Send back to worker</button>
      </div>
    </form>
  ) : (
    <>
      {stale && <div className="draft-conflict review-conflict" role="alert">
        <strong>Timecard changed during your review.</strong>
        <p>Check the latest hours and work date above before making a decision.</p>
        <button ref={reviewButton} className="text-button" type="button" onClick={reviewLatest} disabled={busy}>Review latest timecard <ArrowRight size={15} /></button>
      </div>}
      {!canReturn && <p className="read-only-detail">This timecard has reached its correction limit. It can still be approved.</p>}
      <div className="form-actions decision-actions">
        {canReturn && <button ref={returnButton} className="button button-secondary" type="button" onClick={() => setReturnVersion(reviewedVersion)} disabled={busy || writesBlocked || stale}><CornerUpLeft size={16} /> Return with a note</button>}
        <button className="button button-primary" type="button" onClick={() => void decide('approve')} disabled={busy || writesBlocked || stale}><Check size={17} /> Approve timecard</button>
      </div>
    </>
  )
}

type CardSelection = { onSelectCard: (id: string, replace?: boolean) => void }

export function ForemanView({ cardId, data, busy, writesBlocked, run, go, onSelectCard }: ViewProps & CardSelection) {
  const [filter, setFilter] = useState<'pending' | 'all'>(() => data.timecards.some((card) => card.id === cardId && card.status !== 'pending') ? 'all' : 'pending')
  const pending = data.timecards.filter((card) => card.status === 'pending')
  const shown = filter === 'pending' ? pending : data.timecards
  const selected = data.timecards.find((card) => card.id === cardId)
  const initialLink = useRef(cardId)
  const initialQueueCard = useRef(cardId === null ? pending[0]?.id : undefined)
  const review = useRef<HTMLElement>(null)
  const queue = useRef<HTMLElement>(null)

  useEffect(() => {
    const initialCard = initialQueueCard.current
    initialQueueCard.current = undefined
    if (!cardId && initialCard) onSelectCard(initialCard, true)
  }, [cardId, onSelectCard])

  useEffect(() => {
    if (!initialLink.current) return
    const frame = requestAnimationFrame(() => focusDetails(review.current))
    return () => cancelAnimationFrame(frame)
  }, [])

  function select(card: Timecard, event: MouseEvent<HTMLButtonElement>) {
    onSelectCard(card.id)
    requestAnimationFrame(() => focusDetails(review.current, event))
  }

  return (
    <section aria-labelledby="foreman-title">
      <PageTitle role="foreman" title="Review timecards" description="Check hours for the project, approve the work, or send an entry back with a note." data={data} />
      <div className="content-grid foreman-grid">
        <section className="panel" aria-label="Review queue" ref={queue} tabIndex={-1}>
          <PanelTitle icon={<ClipboardList size={20} />} title="Review queue"><span className="count-pill">{pending.length} pending</span></PanelTitle>
          <div className="filter-group" role="group" aria-label="Filter review queue">
            <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Pending</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
          </div>
          {shown.length ? <div className="card-list">
            {shown.map((card) => <div className="card-list-item" key={card.id}><CardRow card={card} selected={selected?.id === card.id} controls="timecard-review" onClick={(event) => select(card, event)} /></div>)}
          </div> : (
            <Empty title="You’re caught up" text="New submissions and corrected timecards will appear here.">
              <button className="text-button" type="button" onClick={() => go('worker')}>Open worker view <ArrowUpRight size={15} /></button>
            </Empty>
          )}
        </section>
        <section className="panel review-panel" id="timecard-review" aria-label="Timecard review" ref={review} tabIndex={-1}>
          <PanelTitle icon={<FileText size={20} />} title="Timecard review">
            {cardId && <button className="text-button detail-back" type="button" onClick={() => focusLedger(queue.current, selected?.id)}><ArrowLeft size={14} /> Back to review queue</button>}
          </PanelTitle>
          {selected ? <div className="panel-body">
            <CardSummary card={selected} showCost />
            <ForemanDecision key={selected.id} workspaceId={data.workspaceId} card={selected} busy={busy} writesBlocked={writesBlocked} run={run} complete={() => setFilter('all')} />
            <Audit card={selected} />
          </div> : cardId
            ? <Empty title="Selected timecard unavailable" text="Choose another timecard from the review queue." />
            : <Empty title="No timecard selected" text="Open a timecard from the queue to see its hours and activity." />}
        </section>
      </div>
    </section>
  )
}

function Budget({ project, openTimecard, costsStale }: { project: Workspace['project']; openTimecard?: () => void; costsStale?: boolean }) {
  const balance = project.budgetCents - project.approvedCents
  const overBudget = balance < 0
  const used = project.budgetCents ? project.approvedCents / project.budgetCents * 100 : 0
  const percentage = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 1 }).format(used)
  return (
    <section className="panel budget-panel" aria-label="Project labour budget">
      <div className="budget-header">
        <div><p className="eyebrow"><span className="signal-dot" /> {costsStale ? 'Last saved project costs' : 'Live project costs'}</p><h2>{project.name}</h2><p><MapPin size={15} /> {project.location} <span className="budget-divider" /> {project.code}</p></div>
        <span className={`budget-state${overBudget ? ' budget-state-over' : ''}`}>{overBudget ? <CircleAlert size={16} /> : <Check size={16} />} {overBudget ? 'Over budget' : 'Within budget'}</span>
      </div>
      {openTimecard && <button className="budget-handoff" type="button" aria-controls="cost-details" onClick={openTimecard}>View approved timecard <ArrowDown size={15} /></button>}
      <div className="budget-metrics">
        <div><span>Approved labour</span><output id="approved-total" aria-label="Approved labour">{money(project.approvedCents)}</output></div>
        <div><span>Labour budget</span><strong>{money(project.budgetCents)}</strong></div>
        <div><span>Pending labour estimate</span><strong>{money(project.pendingCents)}</strong></div>
      </div>
      <div className="budget-progress">
        <div><strong>{percentage}% of labour budget used</strong><span className={overBudget ? 'over-amount' : ''}>{money(Math.abs(balance))} {overBudget ? 'over budget' : 'remaining'}</span></div>
        <progress className={overBudget ? 'over-progress' : ''} max={100} value={Math.min(used, 100)} aria-hidden="true" />
      </div>
    </section>
  )
}

export function ManagerView({ data, cardId, onSelectCard, costsStale }: { data: Workspace; cardId: string | null; costsStale?: boolean } & CardSelection) {
  const [filter, setFilter] = useState<'approved' | 'all'>(() => data.timecards.some((card) => card.id === cardId && card.status !== 'approved') ? 'all' : 'approved')
  const detail = useRef<HTMLElement>(null)
  const ledger = useRef<HTMLElement>(null)
  const approved = data.timecards.filter((card) => card.status === 'approved')
  const shown = filter === 'approved' ? approved : data.timecards
  const selected = data.timecards.find((card) => card.id === cardId)

  function select(card: Timecard, event: MouseEvent<HTMLButtonElement>) {
    onSelectCard(card.id)
    requestAnimationFrame(() => focusDetails(detail.current, event))
  }

  return (
    <section aria-labelledby="manager-title">
      <PageTitle role="manager" title="Labour budget" description="Compare approved hours against the project’s labour budget and open the timecards behind the total." data={data} />
      <Budget project={data.project} openTimecard={selected?.status === 'approved' ? () => focusDetails(detail.current) : undefined} costsStale={costsStale} />
      <div className="content-grid manager-grid">
        <section className="panel" aria-label="Timecard ledger" ref={ledger} tabIndex={-1}>
          <PanelTitle icon={<ClipboardList size={20} />} title="Timecard ledger"><span className="count-pill">CAD</span></PanelTitle>
          <div className="filter-group" role="group" aria-label="Filter timecard ledger">
            <button type="button" aria-pressed={filter === 'approved'} onClick={() => setFilter('approved')}>Approved</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
          </div>
          {shown.length ? <div className="card-list">
            {shown.map((card) => <div className="card-list-item" key={card.id}><CardRow card={card} showCost selected={cardId === card.id} controls="cost-details" onClick={(event) => select(card, event)} /></div>)}
          </div> : <Empty title="No timecards to show" text="Approved timecards will appear in the project ledger." />}
        </section>
        <section className="panel review-panel" id="cost-details" aria-label="Cost details" ref={detail} tabIndex={-1}>
          <PanelTitle icon={<ChartNoAxesCombined size={20} />} title="Cost details">
            {cardId && <button className="text-button detail-back" type="button" onClick={() => focusLedger(ledger.current, selected?.id)}><ArrowLeft size={14} /> Back to timecard ledger</button>}
          </PanelTitle>
          {selected ? <div className="panel-body"><CardSummary card={selected} showCost /><Audit card={selected} /></div>
            : cardId
              ? <Empty title="Selected timecard unavailable" text="Choose another timecard from the ledger." />
              : <Empty title="Open a timecard" text="See its recorded hours, labour cost, and approval history." />}
        </section>
      </div>
      <p className="budget-footnote"><ArrowDown size={15} /> Pending submissions appear as an estimate until the foreman approves them.</p>
    </section>
  )
}

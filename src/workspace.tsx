import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import {
  ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronRight,
  ClipboardCheck, ClipboardList, Clock3, CornerUpLeft, FileText, MapPin,
} from 'lucide-react'
import { hasVisibleNote } from '../server/note'
import { api, ApiError, type ApprovalPosting, type Role, type Timecard, type Workspace } from './api'
import { CostTrail } from './cost-trail'
import { exampleCorrectedHours, exampleCorrectionNote, exampleInitialHours } from './demo-walkthrough'
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

function isDemoWorker(card: Timecard, worker: Workspace['worker']) {
  return worker.id && card.workerId ? worker.id === card.workerId : worker.name === card.workerName
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
        <p className="section-kicker">
          {role === 'worker' ? 'Field timekeeping' : <><span>{data.project.code}</span> {data.project.name}</>}
        </p>
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

function WorkerProjectRegister({ project }: { project: Workspace['project'] }) {
  return (
    <div className="worker-project-register">
      <div><span>Assigned project</span><strong>{project.name}</strong></div>
      <div className="worker-project-location">
        <span className="worker-project-code">{project.code}</span>
        <span><MapPin size={13} aria-hidden="true" /> {project.location}</span>
      </div>
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
  const hoursField = useRef<HTMLInputElement>(null)
  const unavailable = editing !== null && currentCard?.status !== 'returned'
  const stale = currentCard?.status === 'returned' && currentCard.version !== version
  const note = currentCard?.reason ?? editing?.reason
  const matchingRetry = retryDraft?.workDate === date && retryDraft.hours === Number(hours) ? retryDraft : undefined
  const changedSubmission = !editing && Boolean(retryDraft && !matchingRetry)
  const showExample = !busy && !writesBlocked && !retryDraft && !stale && !unavailable
    && (!editing || note === exampleCorrectionNote)
  const exampleHours = editing ? exampleCorrectedHours : exampleInitialHours

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
      <PanelTitle icon={<FileText size={20} />} title={editing ? 'Correct timecard' : 'New timecard'}>
        {editing && <span className="worker-record-key"><span className="sr-only">Timecard reference </span>{timecardReference(editing)}</span>}
      </PanelTitle>
      <div className="panel-body">
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
                <input ref={hoursField} id="hours-worked" type="number" inputMode="decimal" min="0.01" max="24" step="0.01" value={hours} required onChange={(event) => setHours(event.target.value)} disabled={busy || stale || unavailable} />
                <span aria-hidden="true">hrs</span>
              </span>
            </label>
          </div>
          {showExample ? (
            <div className="worker-example">
              <div><strong>{editing ? 'Correct the example shift' : 'Try the correction walkthrough'}</strong>
                <p>{editing ? 'Enter the full shift, then resubmit for review.' : `Start with ${exampleInitialHours} hours, then submit this shift for review.`}</p></div>
              <button className="text-button" type="button" aria-controls="hours-worked" onClick={() => {
                setHours(String(exampleHours))
                hoursField.current?.focus()
              }}>Use {exampleHours} hours <ArrowRight size={14} /></button>
            </div>
          ) : <p className="field-help">Log regular hours worked on this project.</p>}
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

function CardSummary({ card }: { card: Timecard }) {
  return (
    <>
      <div className="card-summary-header">
        <div><p className="eyebrow">Timecard</p><h3>{card.workerName}</h3></div>
        <Status status={card.status} />
      </div>
      <dl className="card-facts">
        <div><dt>Work date</dt><dd>{workDate(card.workDate)}</dd></div>
        <div><dt>Hours worked</dt><dd>{card.hours} hrs</dd></div>
      </dl>
    </>
  )
}

function CardRow({ card, selected, onClick }: { card: Timecard; selected: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button className={`card-row${selected ? ' card-row-selected' : ''}`} type="button" onClick={onClick}
      data-card-id={card.id} aria-expanded={selected} aria-controls="timecard-review">
      <span className="sr-only">View timecard for </span>
      <span className="card-row-icon"><CalendarDays size={17} /></span>
      <span className="card-row-title"><strong>{card.workerName}</strong><small><time dateTime={card.workDate}>{workDate(card.workDate)}</time> · {card.hours} hrs</small></span>
      <Status status={card.status} />
      <ChevronRight className="row-chevron" size={17} aria-hidden="true" />
    </button>
  )
}

function focusDetails(detail: HTMLElement | null, event?: MouseEvent<HTMLButtonElement>, stacked?: boolean) {
  const mobile = stacked ?? window.matchMedia('(max-width: 800px)').matches
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
  const ownCards = data.timecards.filter((card) => isDemoWorker(card, data.worker))
  const linkedCard = ownCards.find((card) => card.id === cardId)
  const [opening] = useState(() => {
    const attempt = latestAttempt(data.workspaceId, cardId ?? undefined) ?? latestSubmissionAttempt(data.workspaceId)
    const retryCard = ownCards.find((card) => card.id === attempt?.correction?.cardId)
    return { editor: linkedCard?.status === 'returned' ? linkedCard : retryCard ?? null, attempt }
  })
  const [editing, setEditing] = useState(opening.editor)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [correctionRetry, setCorrectionRetry] = useState(() => opening.attempt?.correction ? opening.attempt : undefined)
  const [submissionRetry, setSubmissionRetry] = useState(() => latestSubmissionAttempt(data.workspaceId))
  const formArea = useRef<HTMLDivElement>(null)
  const currentCard = ownCards.find((card) => card.id === editing?.id)
  const retryDraft = editing
    ? correctionRetry?.correction?.cardId === editing.id ? correctionRetry : undefined
    : submissionRetry
  const formRetry = retryDraft && hasAttempt(data.workspaceId, retryDraft.requestId) ? retryDraft : undefined
  const statusOrder = { returned: 0, pending: 1, approved: 2 }
  const sortedCards = [...ownCards].sort((first, second) => statusOrder[first.status] - statusOrder[second.status])
  const primaryCorrection = sortedCards.find((card) => card.status === 'returned')
  const recentCards = sortedCards.filter((card, index) => index < 5 || card.status === 'returned' || card.id === cardId || card.id === openId)
  const displayedCards = showHistory ? sortedCards : recentCards

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
      const field = formArea.current?.querySelector<HTMLInputElement>('#work-date')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView({ block: 'nearest' })
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
    <section className="worker-workspace" aria-labelledby="worker-title">
      <PageTitle role="worker" title="Log a timecard" description="Enter your shift and check its review status." data={data} />
      <div className="content-grid worker-grid worker-register">
        <div className="view-stack" ref={formArea}>
          <WorkerProjectRegister project={data.project} />
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
                {linkedCard ? <><CardSummary card={linkedCard} /><Audit card={linkedCard} /></>
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
          {!cardId && <aside className="next-step"><ClipboardCheck size={17} aria-hidden="true" /><div><h3>Next · Foreman review</h3><p>{data.foreman.name} reviews the shift before it can be approved.</p></div></aside>}
        </div>
        <section className="panel worker-journal" aria-label="My timecards">
          <PanelTitle icon={<Clock3 size={20} />} title="My timecards">
            {recentCards.length < sortedCards.length && (
              <button className="text-button worker-history-toggle" type="button" aria-expanded={showHistory} aria-controls="worker-journal-list"
                aria-label={showHistory ? 'Show recent timecards' : `View all ${sortedCards.length} timecards`}
                onClick={() => setShowHistory((visible) => !visible)}>{showHistory ? 'Show recent' : `View all ${sortedCards.length}`} <ChevronRight size={14} aria-hidden="true" /></button>
            )}
          </PanelTitle>
          {displayedCards.length ? <>
            <div className="worker-journal-head" aria-hidden="true"><span>Work date</span><span>Hours</span><span>Status</span></div>
            <div id="worker-journal-list">
              {displayedCards.map((card) => {
                const open = openId === card.id
                const selected = open || card.id === cardId || card.id === editing?.id
                return (
                  <div className="card-list-item" key={card.id}>
                    <button className={`card-row worker-journal-row${selected ? ' card-row-selected' : ''}`} type="button"
                      data-card-id={card.id} aria-expanded={open} aria-controls={open ? `worker-activity-${card.id}` : undefined}
                      onClick={() => setOpenId((previous) => previous === card.id ? null : card.id)}>
                      <span className="worker-journal-date"><span className="sr-only">View timecard for </span>
                        <time dateTime={card.workDate}>{workDate(card.workDate)}</time><span className="worker-record-key">{timecardReference(card)}</span></span>
                      <span className="worker-journal-hours">{card.hours} hrs</span>
                      <Status status={card.status} />
                      <ChevronRight className="row-chevron" size={16} aria-hidden="true" />
                    </button>
                    {!cardId && card.status === 'returned' && card.id !== primaryCorrection?.id && <div className="row-correction"><p>{card.reason}</p><button className="text-button" type="button" data-correct-card={card.id} onClick={() => edit(card)} disabled={busy || editing?.id === card.id}>Correct and resubmit <ArrowUpRight size={14} /></button></div>}
                    {open && <div className="inline-details" id={`worker-activity-${card.id}`}><Audit card={card} /></div>}
                  </div>
                )
              })}
            </div>
            <p className="worker-journal-foot">{showHistory || recentCards.length === sortedCards.length
              ? `${sortedCards.length} ${sortedCards.length === 1 ? 'timecard' : 'timecards'}`
              : `Showing ${recentCards.length} of ${sortedCards.length} timecards`}</p>
          </> : <Empty title="No timecards yet" text="Your submitted timecards will appear here." />}
        </section>
      </div>
    </section>
  )
}

function ForemanDecision({ workspaceId, card, busy, writesBlocked, run, complete, showExampleCorrection }: { workspaceId: string; card: Timecard; busy: boolean; writesBlocked?: boolean; run: RunMutation; complete: () => void; showExampleCorrection: boolean }) {
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

  if (!pending && !returning) {
    return <p className="read-only-detail">This timecard is no longer pending. {card.status === 'returned' ? 'It is with the worker for correction.' : 'The cost is in the labour ledger.'}</p>
  }

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
      <p className="foreman-note-help" id="foreman-correction-hint">The worker sees this note when they open the timecard to make changes.</p>
      <textarea ref={note} id="correction-note" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={300} rows={3} placeholder="Tell the worker what to change…" disabled={busy} readOnly={!pending || stale || !canReturn}
        aria-invalid={invisibleReason || undefined} aria-describedby={invisibleReason ? 'foreman-correction-hint correction-note-help' : 'foreman-correction-hint'} />
      {showExampleCorrection && pending && canReturn && !stale && !busy && !writesBlocked && reason.length === 0 && (
        <button className="text-button foreman-note-example" type="button" onClick={() => {
          setReason(exampleCorrectionNote)
          requestAnimationFrame(() => note.current?.focus())
        }}>Use example note <ArrowRight size={14} /></button>
      )}
      {invisibleReason && <p className="field-help" id="correction-note-help">Include a visible correction note.</p>}
      {pending && !canReturn && <p className="field-help">This timecard has reached its correction limit. It can still be approved.</p>}
      <div className="form-actions">
        <button className="button button-secondary" type="button" onClick={cancel} disabled={busy}>Cancel</button>
        <button className="button button-primary" type="submit" disabled={busy || writesBlocked || !pending || stale || !canReturn || !validReason}><CornerUpLeft size={16} /> Send back to worker</button>
      </div>
    </form>
  ) : (
    <div className="foreman-decision">
      <h4>Review decision</h4>
      <p>Approval posts this timecard to the labour ledger.</p>
      {showExampleCorrection && canReturn && !stale && (
        <p className="foreman-decision-example"><CornerUpLeft size={15} aria-hidden="true" /><span><strong>Try a correction.</strong> Return this entry and ask {card.workerName.split(' ')[0]} to include the final hour.</span></p>
      )}
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
    </div>
  )
}

type CardSelection = { onSelectCard: (id: string, replace?: boolean) => void }

function ForemanSource({ card }: { card: Timecard }) {
  const approved = card.status === 'approved'
  return (
    <>
      <div className="foreman-source-person">
        <Status status={card.status} />
        <h3>{card.workerName}</h3>
        <p>Work date <time dateTime={card.workDate}>{workDate(card.workDate)}</time></p>
      </div>
      <dl className="foreman-source-facts">
        <div><dt>Hours worked</dt><dd>{card.hours} hrs</dd></div>
        <div><dt>{approved ? 'Applied rate' : 'Estimated rate'}</dt><dd>{card.rateCents === null ? 'Rate unavailable' : `${money(card.rateCents)}/hr`}</dd></div>
      </dl>
      <dl className="foreman-source-value">
        <div><dt>{approved ? 'Posted labour' : 'Estimated labour'}</dt><dd>{timecardCost(card.costCents)}</dd></div>
      </dl>
    </>
  )
}

export function ForemanView({ cardId, data, busy, writesBlocked, run, go, onSelectCard }: ViewProps & CardSelection) {
  const [filter, setFilter] = useState<'pending' | 'all'>(() => data.timecards.some((card) => card.id === cardId && card.status !== 'pending') ? 'all' : 'pending')
  const pending = data.timecards.filter((card) => card.status === 'pending')
  const shown = filter === 'pending' ? pending : data.timecards
  const selected = data.timecards.find((card) => card.id === cardId)
  const returnedCount = data.timecards.filter((card) => card.status === 'returned').length
  const showQueueContext = selected?.status === 'pending' && filter === 'pending' && pending.length < 3
  const recent = !cardId || showQueueContext ? data.timecards.filter((card) => card.status === 'approved')
    .sort((first, second) => (second.decisionAt ?? '').localeCompare(first.decisionAt ?? '')).slice(0, showQueueContext ? 3 : 4) : []
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
    const frame = requestAnimationFrame(() => focusDetails(review.current, undefined, review.current?.offsetWidth === queue.current?.offsetWidth))
    return () => cancelAnimationFrame(frame)
  }, [])

  function select(card: Timecard, event?: MouseEvent<HTMLButtonElement>) {
    if (card.status !== 'pending') setFilter('all')
    onSelectCard(card.id)
    requestAnimationFrame(() => focusDetails(review.current, event, review.current?.offsetWidth === queue.current?.offsetWidth))
  }

  const recentApprovals = recent.length > 0 && (
    <div className="foreman-recent">
      <h3>Recent approvals</h3>
      <ul>
        {recent.map((card) => <li key={card.id}>
          <button type="button" aria-controls="timecard-review" onClick={() => select(card)}>
            <span><strong>{card.workerName}</strong><time dateTime={card.workDate}>{workDate(card.workDate)}</time></span>
            <span>{card.hours} hrs</span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </li>)}
      </ul>
    </div>
  )

  return (
    <section className="foreman-workspace" aria-labelledby="foreman-title">
      <PageTitle role="foreman" title="Review timecards" description="Review submitted hours for the project. Approvals post to the labour ledger." data={data} />
      <div className="content-grid foreman-grid foreman-board">
        <section className="panel foreman-queue" aria-label="Review queue" ref={queue} tabIndex={-1}>
          <PanelTitle icon={<ClipboardList size={17} />} title="Review queue"><span className="count-pill">{pending.length} pending</span></PanelTitle>
          <div className="filter-group" role="group" aria-label="Filter review queue">
            <button type="button" aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>Pending</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
          </div>
          {shown.length ? <div className="card-list">
            {shown.map((card) => <div className="card-list-item" key={card.id}><CardRow card={card} selected={selected?.id === card.id} onClick={(event) => select(card, event)} /></div>)}
          </div> : (
            <div className="foreman-queue-empty">
              <ClipboardCheck size={19} aria-hidden="true" />
              <div>
                <h3>{filter === 'pending' ? 'Queue clear' : 'No timecards yet'}</h3>
                <p>Submitted and corrected timecards appear here when they’re ready for review.</p>
                <button className="text-button" type="button" onClick={() => go('worker')}>Open worker view <ArrowUpRight size={15} /></button>
              </div>
            </div>
          )}
          {returnedCount > 0 && filter === 'pending' && (
            <div className="foreman-queue-returned">
              <CornerUpLeft size={15} aria-hidden="true" />
              <span>{returnedCount} {returnedCount === 1 ? 'timecard' : 'timecards'} with workers for correction</span>
              <button className="text-button" type="button" onClick={() => setFilter('all')}>View all <ArrowRight size={14} /></button>
            </div>
          )}
          {showQueueContext && recentApprovals}
        </section>
        <section className="panel review-panel foreman-review" id="timecard-review" aria-label="Timecard review" ref={review} tabIndex={-1}>
          <PanelTitle icon={<FileText size={17} />} title="Timecard review">
            {cardId && <div className="foreman-review-tools">
              {selected && <span className="foreman-trace-key"><span className="sr-only">Timecard reference </span>{timecardReference(selected)}</span>}
              <button className="text-button detail-back" type="button" onClick={() => focusLedger(queue.current, selected?.id)}><ArrowLeft size={14} /> Back to review queue</button>
            </div>}
          </PanelTitle>
          {selected ? <div className="foreman-review-body">
            <div className="foreman-source">
              <ForemanSource card={selected} />
              <ForemanDecision key={selected.id} workspaceId={data.workspaceId} card={selected} busy={busy} writesBlocked={writesBlocked} run={run}
                showExampleCorrection={isDemoWorker(selected, data.worker) && selected.hours === exampleInitialHours} complete={() => setFilter('all')} />
            </div>
            <div className="foreman-history">
              <Audit card={selected} />
              {selected.audit.length > 0 && <p className="foreman-history-zone">Project time · Toronto</p>}
            </div>
          </div> : cardId
            ? <Empty title="Selected timecard unavailable" text="Choose another timecard from the review queue." />
            : <div className="foreman-review-idle">
              <h3>Crew activity</h3>
              <p>No timecard selected. Open a submission from the queue to check its hours and make a decision.</p>
              {recentApprovals}
            </div>}
        </section>
      </div>
    </section>
  )
}

function timecardReference(card: Timecard) {
  return card.id.slice(0, 8).toUpperCase()
}

function CostSource({ card, sourceAnchor }: { card: Timecard; sourceAnchor: RefObject<SVGSVGElement | null> }) {
  const approved = card.status === 'approved'
  return (
    <>
      <div className="manager-source-person">
        <Status status={card.status} />
        <h3>{card.workerName}</h3>
        <p>Work date <time dateTime={card.workDate}>{workDate(card.workDate)}</time></p>
      </div>
      <dl className="manager-source-facts">
        <div><dt>Hours worked</dt><dd>{card.hours} hrs</dd></div>
        <div><dt>{approved ? 'Applied rate' : 'Estimated rate'}</dt><dd>{typeof card.rateCents === 'number' ? `${money(card.rateCents)}/hr` : 'Rate unavailable'}</dd></div>
      </dl>
      <div className="manager-source-value">
        <div><span>{approved ? 'Posting value' : 'Estimated value'}</span><strong>{timecardCost(card.costCents)}</strong></div>
        <svg ref={sourceAnchor} viewBox="0 0 35 21" width="35" height="21" aria-hidden="true" fill="none"><path d="M1 6h12l5 9h15m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      {typeof card.rateCents === 'number' && <p className="manager-source-calculation">{card.hours} hrs × {money(card.rateCents)}/hr</p>}
      <Audit card={card} />
    </>
  )
}

export function ManagerView({ data, cardId, onSelectCard, costsStale, posting }: {
  data: Workspace
  cardId: string | null
  costsStale?: boolean
  posting?: ApprovalPosting
} & CardSelection) {
  const [filter, setFilter] = useState<'approved' | 'all'>(() => data.timecards.some((card) => card.id === cardId && card.status !== 'approved') ? 'all' : 'approved')
  const detail = useRef<HTMLElement>(null)
  const ledger = useRef<HTMLElement>(null)
  const sourceAnchor = useRef<SVGSVGElement>(null)
  const approved = data.timecards.filter((card) => card.status === 'approved')
  const shown = filter === 'approved' ? approved : data.timecards
  const selected = data.timecards.find((card) => card.id === cardId)

  useLayoutEffect(() => {
    const scroll = ledger.current?.querySelector<HTMLElement>('.manager-ledger-scroll')
    const row = scroll?.querySelector('tr[data-selected="true"]')
    if (!scroll || !row) return
    const bounds = scroll.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    const top = scroll.querySelector('thead')?.getBoundingClientRect().bottom ?? bounds.top
    if (rowBounds.top < top - 1 || rowBounds.bottom > bounds.bottom + 1) {
      scroll.scrollTop += rowBounds.top - top
    }
  }, [cardId, filter])

  function showSource(event?: MouseEvent<HTMLButtonElement>) {
    const stacked = detail.current?.offsetWidth === ledger.current?.offsetWidth
    focusDetails(detail.current, event, stacked)
  }

  function select(card: Timecard, event: MouseEvent<HTMLButtonElement>) {
    onSelectCard(card.id)
    requestAnimationFrame(() => showSource(event))
  }

  return (
    <section className="fieldbook-manager" aria-labelledby="manager-title">
      <PageTitle role="manager" title="Labour budget" description="Trace approved labour back to the work that posted it." data={data} />
      <div className="manager-register">
        <CostTrail project={data.project} card={selected} recordCode={selected && timecardReference(selected)}
          openTimecard={selected?.status === 'approved' ? () => showSource() : undefined}
          costsStale={costsStale} posting={posting} sourceAnchor={sourceAnchor} money={money} />
        <section className="manager-ledger" aria-label="Timecard ledger" ref={ledger} tabIndex={-1}>
          <header className="manager-ledger-head">
            <div><h2>Labour postings</h2><span>{shown.length} {shown.length === 1 ? 'timecard' : 'timecards'} · CAD</span></div>
            <div className="filter-group" role="group" aria-label="Filter timecard ledger">
              <button type="button" aria-pressed={filter === 'approved'} onClick={() => setFilter('approved')}>Approved</button>
              <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All timecards</button>
            </div>
          </header>
          {shown.length ? (
            <div className="manager-ledger-scroll"><table className="manager-ledger-table">
              <thead><tr><th scope="col">Timecard</th><th scope="col">Work date</th><th scope="col" className="manager-numeric">Hours</th><th scope="col" className="manager-numeric">Labour cost</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {shown.map((card) => (
                  <tr key={card.id} data-selected={cardId === card.id} data-posted={posting?.cardId === card.id && cardId === card.id}>
                    <th scope="row">
                      <button className="card-row manager-ledger-button" type="button" data-card-id={card.id} aria-expanded={cardId === card.id} aria-controls="cost-details" onClick={(event) => select(card, event)}>
                        <span className="sr-only">View timecard for </span>
                        <span className="field-trace-key">{timecardReference(card)}</span>
                        <span className="card-row-title"><strong>{card.workerName}</strong><span className="manager-row-date">{workDate(card.workDate)}</span></span>
                        <span className="sr-only">{card.hours} hrs</span>
                      </button>
                    </th>
                    <td><time dateTime={card.workDate}>{workDate(card.workDate)}</time></td>
                    <td className="manager-numeric">{card.hours}</td>
                    <td className="manager-numeric"><strong>{timecardCost(card.costCents)}</strong>{card.status !== 'approved' && card.costCents !== null && <small> est.</small>}</td>
                    <td><Status status={card.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <Empty title="No timecards to show" text="Approved timecards will appear in the project ledger." />}
        </section>
        <section className="manager-source" id="cost-details" aria-label="Cost details" ref={detail} tabIndex={-1}>
          <header className="manager-source-head">
            <h2>Source timecard</h2>
            {selected && <span className="field-trace-key">{timecardReference(selected)}</span>}
          </header>
          {selected ? <CostSource card={selected} sourceAnchor={sourceAnchor} />
            : cardId
              ? <Empty title="Selected timecard unavailable" text="Choose another timecard from the ledger." />
              : <Empty title="Open a timecard" text="See its recorded hours, labour cost, and approval history." />}
          {cardId && <button className="text-button manager-source-back" type="button" onClick={() => focusLedger(ledger.current, selected?.id)}><ArrowLeft size={15} /> Back to timecard ledger</button>}
        </section>
      </div>
    </section>
  )
}

export type SubmissionAttempt = {
  workDate: string
  hours: number
  requestId: string
  correction?: { cardId: string; version: number }
  attemptedAt?: number
}

type RetryState = { workspaceId: string; attempts: SubmissionAttempt[] }
type RetryStore = { key: string; correction: boolean; current?: RetryState | null }

// Keep correction drafts separate so an older bundle cannot treat them as new submissions.
const submissionStore: RetryStore = { key: 'fieldledger.submission-retries.v1', correction: false }
const correctionStore: RetryStore = { key: 'fieldledger.correction-retries.v1', correction: true }
const stores = [submissionStore, correctionStore]

function isAttempt(value: unknown): value is SubmissionAttempt {
  if (!value || typeof value !== 'object') return false
  const { workDate, hours, requestId, correction, attemptedAt } = value as Partial<SubmissionAttempt>
  return typeof workDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(workDate)
    && typeof hours === 'number' && hours >= 0.01 && hours <= 24
    && typeof requestId === 'string' && /^[0-9a-f-]{36}$/i.test(requestId)
    && (attemptedAt === undefined || Number.isFinite(attemptedAt))
    && (correction === undefined || Boolean(correction && typeof correction.cardId === 'string'
      && /^[0-9a-f-]{36}$/i.test(correction.cardId) && Number.isInteger(correction.version) && correction.version > 0))
}

function read(store: RetryStore): RetryState | null {
  if (store.current !== undefined) return store.current
  store.current = null
  try {
    const stored = sessionStorage.getItem(store.key)
    if (!stored) return store.current
    const parsed = JSON.parse(stored) as Partial<RetryState> | null
    if (typeof parsed?.workspaceId === 'string' && Array.isArray(parsed.attempts)) {
      const attempts = parsed.attempts.filter(isAttempt).filter((attempt) => Boolean(attempt.correction) === store.correction)
      store.current = { workspaceId: parsed.workspaceId, attempts }
    }
  } catch {
    // In-memory state still protects retries during this page visit.
  }
  return store.current
}

function write(store: RetryStore, value: RetryState | null) {
  store.current = value
  try {
    if (value) sessionStorage.setItem(store.key, JSON.stringify(value))
    else sessionStorage.removeItem(store.key)
  } catch {
    // Some browsers disable storage or restrict access to it.
  }
}

function inWorkspace(store: RetryStore, workspaceId: string) {
  const stored = read(store)
  return stored?.workspaceId === workspaceId ? stored.attempts : []
}

export function selectRetryWorkspace(workspaceId: string) {
  for (const store of stores) {
    const stored = read(store)
    if (stored && stored.workspaceId !== workspaceId) write(store, null)
  }
}

export function latestAttempt(workspaceId: string, cardId?: string) {
  const corrections = inWorkspace(correctionStore, workspaceId)
  if (cardId) return corrections.filter((attempt) => attempt.correction?.cardId === cardId).at(-1)
  const correction = corrections.at(-1)
  const submission = inWorkspace(submissionStore, workspaceId).at(-1)
  return correction && (!submission || (correction.attemptedAt ?? 0) >= (submission.attemptedAt ?? 0)) ? correction : submission
}

export function hasAttempt(workspaceId: string, requestId: string) {
  return stores.some((store) => inWorkspace(store, workspaceId).some((attempt) => attempt.requestId === requestId))
}

export function rememberAttempt(workspaceId: string, workDate: string, hours: number, correction?: SubmissionAttempt['correction']) {
  const store = correction ? correctionStore : submissionStore
  const attempts = inWorkspace(store, workspaceId)
  const existing = attempts.find((attempt) => attempt.workDate === workDate && attempt.hours === hours
    && attempt.correction?.cardId === correction?.cardId && attempt.correction?.version === correction?.version)
  const attempt = { workDate, hours, requestId: existing?.requestId ?? crypto.randomUUID(), correction, attemptedAt: Date.now() }
  write(store, { workspaceId, attempts: [...attempts.filter((item) => item !== existing), attempt] })
  return attempt
}

export function confirmAttempt(workspaceId: string, requestId: string) {
  for (const store of stores) {
    const previous = inWorkspace(store, workspaceId)
    const attempts = previous.filter((item) => item.requestId !== requestId)
    if (attempts.length !== previous.length) write(store, attempts.length ? { workspaceId, attempts } : null)
  }
}

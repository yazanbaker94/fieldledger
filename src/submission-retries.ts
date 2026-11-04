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
const sharedPrefix = 'fieldledger.shared-submission-retries.v1.'
let selectedWorkspace: string | undefined

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

function parseShared(value: string | null) {
  try {
    const parsed: unknown = value && JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(isAttempt).filter((attempt) => !attempt.correction) : []
  } catch {
    return []
  }
}

function submissions(workspaceId: string) {
  const legacy = inWorkspace(submissionStore, workspaceId)
  try {
    const shared = parseShared(localStorage.getItem(sharedPrefix + workspaceId))
    return [...legacy.filter((old) => !shared.some((attempt) => attempt.requestId === old.requestId)), ...shared]
      .sort((left, right) => (left.attemptedAt ?? 0) - (right.attemptedAt ?? 0))
  } catch {
    return legacy
  }
}

function writeSubmissions(workspaceId: string, attempts: SubmissionAttempt[]) {
  try {
    const key = sharedPrefix + workspaceId
    if (attempts.length) localStorage.setItem(key, JSON.stringify(attempts))
    else localStorage.removeItem(key)
    if (read(submissionStore)?.workspaceId === workspaceId) write(submissionStore, null)
  } catch {
    write(submissionStore, attempts.length ? { workspaceId, attempts } : null)
  }
}

async function withSubmissionLock<T>(workspaceId: string, change: () => T): Promise<T> {
  if (!navigator.locks) return change()
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 3000)
  try {
    return await navigator.locks.request(sharedPrefix + workspaceId, { signal: controller.signal }, change)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'SecurityError') return change()
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

export function onSubmissionAttemptsChanged(workspaceId: string, changed: (removed?: SubmissionAttempt) => void) {
  function onStorage(event: StorageEvent) {
    if (event.key !== sharedPrefix + workspaceId) return
    const current = parseShared(event.newValue)
    const removed = parseShared(event.oldValue).find((attempt) => !current.some((next) => next.requestId === attempt.requestId))
    changed(removed)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}

export function selectRetryWorkspace(workspaceId: string) {
  if (selectedWorkspace === workspaceId) return
  const previousWorkspace = selectedWorkspace
  selectedWorkspace = workspaceId
  for (const store of stores) {
    const stored = read(store)
    if (stored && stored.workspaceId !== workspaceId) write(store, null)
  }
  if (previousWorkspace) {
    try {
      localStorage.removeItem(sharedPrefix + previousWorkspace)
    } catch {
      // Per-tab storage still handles retries when shared storage is unavailable.
    }
  }
  if (inWorkspace(submissionStore, workspaceId).length) {
    void withSubmissionLock(workspaceId, () => {
      if (selectedWorkspace === workspaceId && inWorkspace(submissionStore, workspaceId).length) {
        writeSubmissions(workspaceId, submissions(workspaceId))
      }
    }).catch(() => {})
  }
}

export function latestSubmissionAttempt(workspaceId: string) {
  return submissions(workspaceId).at(-1)
}

export function latestAttempt(workspaceId: string, cardId?: string) {
  const corrections = inWorkspace(correctionStore, workspaceId)
  if (cardId) return corrections.filter((attempt) => attempt.correction?.cardId === cardId).at(-1)
  const correction = corrections.at(-1)
  const submission = latestSubmissionAttempt(workspaceId)
  return correction && (!submission || (correction.attemptedAt ?? 0) >= (submission.attemptedAt ?? 0)) ? correction : submission
}

export function hasAttempt(workspaceId: string, requestId: string) {
  return [...submissions(workspaceId), ...inWorkspace(correctionStore, workspaceId)].some((attempt) => attempt.requestId === requestId)
}

export async function rememberAttempt(workspaceId: string, workDate: string, hours: number,
  correction?: SubmissionAttempt['correction'], expectedRequestId?: string) {
  if (!correction) {
    return withSubmissionLock(workspaceId, () => {
      if (selectedWorkspace !== workspaceId) return undefined
      const attempts = submissions(workspaceId)
      const latest = attempts.at(-1)
      if (expectedRequestId && latest?.requestId !== expectedRequestId) return undefined
      if (latest) return latest.workDate === workDate && latest.hours === hours ? latest : undefined
      const attempt = { workDate, hours, requestId: crypto.randomUUID(), attemptedAt: Date.now() }
      writeSubmissions(workspaceId, [attempt])
      return attempt
    })
  }
  const attempts = inWorkspace(correctionStore, workspaceId)
  const existing = attempts.find((attempt) => attempt.workDate === workDate && attempt.hours === hours
    && attempt.correction?.cardId === correction.cardId && attempt.correction?.version === correction.version)
  const attempt = { workDate, hours, requestId: existing?.requestId ?? crypto.randomUUID(), correction, attemptedAt: Date.now() }
  write(correctionStore, { workspaceId, attempts: [...attempts.filter((item) => item !== existing), attempt] })
  return attempt
}

export async function confirmAttempt(workspaceId: string, attempt: SubmissionAttempt) {
  if (attempt.correction) {
    const previous = inWorkspace(correctionStore, workspaceId)
    const attempts = previous.filter((item) => item.requestId !== attempt.requestId)
    if (attempts.length !== previous.length) write(correctionStore, attempts.length ? { workspaceId, attempts } : null)
  } else {
    await withSubmissionLock(workspaceId, () => {
      const previous = submissions(workspaceId)
      const attempts = previous.filter((item) => item.requestId !== attempt.requestId)
      if (attempts.length !== previous.length) writeSubmissions(workspaceId, attempts)
    }).catch(() => {})
  }
}

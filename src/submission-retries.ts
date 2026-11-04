export type SubmissionAttempt = {
  workDate: string
  hours: number
  requestId: string
}

type RetryState = { workspaceId: string; attempts: SubmissionAttempt[] }

const storageKey = 'fieldledger.submission-retries.v1'
let current: RetryState | null | undefined

function isAttempt(value: unknown): value is SubmissionAttempt {
  if (!value || typeof value !== 'object') return false
  const { workDate, hours, requestId } = value as Partial<SubmissionAttempt>
  return typeof workDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(workDate)
    && typeof hours === 'number' && hours >= 0.01 && hours <= 24
    && typeof requestId === 'string' && /^[0-9a-f-]{36}$/i.test(requestId)
}

function read(): RetryState | null {
  if (current !== undefined) return current
  current = null
  try {
    const stored = sessionStorage.getItem(storageKey)
    if (!stored) return current
    const parsed = JSON.parse(stored) as Partial<RetryState> | null
    if (typeof parsed?.workspaceId === 'string' && Array.isArray(parsed.attempts)) {
      current = { workspaceId: parsed.workspaceId, attempts: parsed.attempts.filter(isAttempt) }
    }
  } catch {
    // In-memory state still protects retries during this page visit.
  }
  return current
}

function write(value: RetryState | null) {
  current = value
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
    else sessionStorage.removeItem(storageKey)
  } catch {
    // Some browsers disable storage or restrict access to it.
  }
}

export function selectRetryWorkspace(workspaceId: string) {
  const stored = read()
  if (stored && stored.workspaceId !== workspaceId) write(null)
}

export function latestAttempt(workspaceId: string) {
  const stored = read()
  return stored?.workspaceId === workspaceId ? stored.attempts.at(-1) : undefined
}

export function rememberAttempt(workspaceId: string, workDate: string, hours: number) {
  const stored = read()
  const attempts = stored?.workspaceId === workspaceId ? stored.attempts : []
  const existing = attempts.find((attempt) => attempt.workDate === workDate && attempt.hours === hours)
  const attempt = existing ?? { workDate, hours, requestId: crypto.randomUUID() }
  write({ workspaceId, attempts: [...attempts.filter((item) => item !== existing), attempt] })
  return attempt
}

export function confirmAttempt(workspaceId: string, requestId: string) {
  const stored = read()
  if (stored?.workspaceId !== workspaceId) return
  const attempts = stored.attempts.filter((item) => item.requestId !== requestId)
  write(attempts.length ? { workspaceId, attempts } : null)
}

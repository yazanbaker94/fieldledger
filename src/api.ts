export type Role = 'worker' | 'foreman' | 'manager'
export type CardStatus = 'pending' | 'returned' | 'approved'
export type ApprovalPosting = { cardId: string; beforeCents: number; afterCents: number }

export type Timecard = {
  id: string
  workerId?: string
  workerName: string
  workDate: string
  hours: number
  status: CardStatus
  submittedAt: string
  decisionAt: string | null
  decisionBy: string | null
  reason: string | null
  costCents: number | null
  rateCents: number | null
  approvedBeforeCents?: number | null
  version: number
  canReturn?: boolean
  audit: {
    action: 'submitted' | 'returned' | 'resubmitted' | 'approved'
    actor: string
    at: string
    note: string | null
    previousWorkDate?: string | null
    previousHours?: number | null
    workDate?: string | null
    hours?: number | null
  }[]
}

export type Workspace = {
  workspaceId: string
  affectedCardId?: string
  project: {
    id: string
    name: string
    code: string
    location: string
    budgetCents: number
    approvedCents: number
    pendingCents: number
  }
  worker: { id?: string; name: string }
  foreman: { name: string }
  manager: { name: string }
  timecards: Timecard[]
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly retryAt?: number) {
    super(message)
  }
}

type RequestOptions = {
  body?: object
  open?: boolean
  role?: Role
  workspaceId?: string
  idempotencyKey?: string
  signal?: AbortSignal
  timeout?: number
}

async function request(path: string, { body, open, role, workspaceId, idempotencyKey, signal, timeout = 10000 }: RequestOptions = {}): Promise<Workspace> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = window.setTimeout(() => { timedOut = true; abort() }, timeout)
  try {
    const response = await fetch(`/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        ...(body && { 'Content-Type': 'application/json' }),
        ...(open && { 'X-Demo-Open': '1' }),
        ...(role && { 'X-Demo-Role': role }),
        ...(workspaceId && { 'X-Demo-Workspace': workspaceId }),
        ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
      },
      body: body && JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string; code?: string } | null
      const retryAfter = response.status === 429 ? response.headers.get('Retry-After') : null
      const retryAt = retryAfter && (/^\d+$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter))
      throw new ApiError(error?.message ?? 'The workspace is temporarily unavailable. Try again shortly.', response.status,
        error?.code, typeof retryAt === 'number' && retryAt > Date.now() ? retryAt : undefined)
    }
    return await response.json() as Workspace
  } catch (error) {
    if (timedOut) throw new ApiError('The connection timed out. Check the workspace and try again.', 504)
    throw error
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function recoverWrite(workspaceId: string, write: () => Promise<Workspace>, matches: (workspace: Workspace) => boolean, cardId?: string) {
  try {
    return await write()
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.status !== 408 && !(cardId && error.status === 409 && !error.code)) throw error
    const workspace = await request('/workspace', { workspaceId, timeout: 5000 }).catch(() => null)
    if (workspace && matches(workspace)) return { ...workspace, affectedCardId: cardId }
    throw error
  }
}

function containsDecision(workspace: Workspace, cardId: string, version: number, decision: 'approve' | 'return', reason?: string) {
  const card = workspace.timecards.find((entry) => entry.id === cardId)
  if (!card || card.version <= version) return false
  const status = decision === 'approve' ? 'approved' : 'returned'
  const note = decision === 'approve' ? null : reason?.trim()
  if (card.version === version + 1 && card.status === status && card.decisionBy === workspace.foreman.name && card.reason === note) return true
  // Each submitted card records its initial entry and one event for each later version.
  const event = card.audit.length === card.version ? card.audit[version] : undefined
  return event?.action === status && event.actor === workspace.foreman.name && event.note === note
}

export const api = {
  openWorkspace: (signal: AbortSignal) => request('/workspace', { signal, open: true }),
  readWorkspace: (workspaceId: string) => request('/workspace', { workspaceId }),
  submit: (workspaceId: string, workDate: string, hours: number, requestId: string) =>
    request('/timecards', { body: { workDate, hours, requestId }, role: 'worker', workspaceId }),
  findSubmission: (workspaceId: string, requestId: string) =>
    request(`/timecards/submissions/${encodeURIComponent(requestId)}`, { workspaceId, timeout: 5000 }),
  discardSubmission: (workspaceId: string, requestId: string) =>
    request(`/timecards/submissions/${encodeURIComponent(requestId)}/discard`, { body: {}, role: 'worker', workspaceId }),
  resubmit: (workspaceId: string, cardId: string, version: number, workDate: string, hours: number, requestId: string) =>
    request(`/timecards/${encodeURIComponent(cardId)}/resubmit`, {
      body: { workDate, hours, version },
      role: 'worker',
      workspaceId,
      idempotencyKey: requestId,
    }),
  decide: (workspaceId: string, cardId: string, version: number, decision: 'approve' | 'return', reason?: string) =>
    recoverWrite(
      workspaceId,
      () => request(`/timecards/${encodeURIComponent(cardId)}/decision`, { body: { decision, reason, version }, role: 'foreman', workspaceId }),
      (workspace) => workspace.workspaceId === workspaceId && containsDecision(workspace, cardId, version, decision, reason),
      cardId,
    ),
  reset: (workspaceId: string) => recoverWrite(
    workspaceId,
    () => request('/reset', { body: {}, workspaceId }),
    (workspace) => workspace.workspaceId !== workspaceId,
  ),
}

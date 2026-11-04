export type Role = 'worker' | 'foreman' | 'manager'
export type CardStatus = 'pending' | 'returned' | 'approved'

export type Timecard = {
  id: string
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
  worker: { name: string }
  foreman: { name: string }
  manager: { name: string }
  timecards: Timecard[]
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

type RequestOptions = {
  body?: object
  role?: Role
  workspaceId?: string
  idempotencyKey?: string
  signal?: AbortSignal
  timeout?: number
}

async function request(path: string, { body, role, workspaceId, idempotencyKey, signal, timeout = 10000 }: RequestOptions = {}): Promise<Workspace> {
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
        ...(role && { 'X-Demo-Role': role }),
        ...(workspaceId && { 'X-Demo-Workspace': workspaceId }),
        ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
      },
      body: body && JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => null) as { message?: string; code?: string } | null
      throw new ApiError(error?.message ?? 'The workspace is temporarily unavailable. Try again shortly.', response.status, error?.code)
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

async function recoverWrite(write: () => Promise<Workspace>, matches: (workspace: Workspace) => boolean, cardId?: string) {
  try {
    return await write()
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) throw error
    const workspace = await request('/workspace', { timeout: 5000 }).catch(() => null)
    if (workspace && matches(workspace)) return { ...workspace, affectedCardId: cardId }
    throw error
  }
}

export const api = {
  workspace: (signal?: AbortSignal) => request('/workspace', { signal }),
  submit: (workspaceId: string, workDate: string, hours: number, requestId: string) =>
    request('/timecards', { body: { workDate, hours, requestId }, role: 'worker', workspaceId }),
  findSubmission: (workspaceId: string, requestId: string) =>
    request(`/timecards/submissions/${encodeURIComponent(requestId)}`, { workspaceId, timeout: 5000 }),
  resubmit: (workspaceId: string, cardId: string, version: number, workDate: string, hours: number, requestId: string) =>
    request(`/timecards/${encodeURIComponent(cardId)}/resubmit`, {
      body: { workDate, hours, version },
      role: 'worker',
      workspaceId,
      idempotencyKey: requestId,
    }),
  decide: (workspaceId: string, cardId: string, version: number, decision: 'approve' | 'return', reason?: string) =>
    recoverWrite(
      () => request(`/timecards/${encodeURIComponent(cardId)}/decision`, { body: { decision, reason, version }, role: 'foreman', workspaceId }),
      (workspace) => workspace.workspaceId === workspaceId && workspace.timecards.some((card) => card.id === cardId
        && card.version === version + 1 && card.decisionBy === workspace.foreman.name
        && (decision === 'approve' ? card.status === 'approved' : card.status === 'returned' && card.reason === reason)),
      cardId,
    ),
  reset: (workspaceId: string) => recoverWrite(
    () => request('/reset', { body: {}, workspaceId }),
    (workspace) => workspace.workspaceId !== workspaceId,
  ),
}

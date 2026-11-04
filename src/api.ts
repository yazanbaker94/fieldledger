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
  audit: {
    action: 'submitted' | 'returned' | 'resubmitted' | 'approved'
    actor: string
    at: string
    note: string | null
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
  signal?: AbortSignal
}

async function request(path: string, { body, role, workspaceId, signal }: RequestOptions = {}): Promise<Workspace> {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
      ...(role && { 'X-Demo-Role': role }),
      ...(workspaceId && { 'X-Demo-Workspace': workspaceId }),
    },
    body: body && JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string } | null
    throw new ApiError(error?.message ?? 'The workspace is temporarily unavailable. Try again shortly.', response.status, error?.code)
  }

  return response.json() as Promise<Workspace>
}

export const api = {
  workspace: (signal?: AbortSignal) => request('/workspace', { signal }),
  submit: (workspaceId: string, workDate: string, hours: number, requestId: string) =>
    request('/timecards', { body: { workDate, hours, requestId }, role: 'worker', workspaceId }),
  findSubmission: (workspaceId: string, requestId: string) =>
    request(`/timecards/submissions/${encodeURIComponent(requestId)}`, { workspaceId, signal: AbortSignal.timeout(5000) }),
  resubmit: (workspaceId: string, card: Timecard, workDate: string, hours: number) =>
    request(`/timecards/${encodeURIComponent(card.id)}/resubmit`, { body: { workDate, hours, version: card.version }, role: 'worker', workspaceId }),
  decide: (workspaceId: string, card: Timecard, decision: 'approve' | 'return', reason?: string) =>
    request(`/timecards/${encodeURIComponent(card.id)}/decision`, { body: { decision, reason, version: card.version }, role: 'foreman', workspaceId }),
  reset: (workspaceId: string) => request('/reset', { body: {}, workspaceId }),
}

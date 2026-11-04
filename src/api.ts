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
  version: number
  audit: {
    action: 'submitted' | 'returned' | 'resubmitted' | 'approved'
    actor: string
    at: string
    note: string | null
  }[]
}

export type Workspace = {
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
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function request(path: string, body?: object, role?: Role): Promise<Workspace> {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
      ...(role && { 'X-Demo-Role': role }),
    },
    body: body && JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null
    throw new ApiError(error?.message ?? 'The workspace is temporarily unavailable. Try again shortly.', response.status)
  }

  return response.json() as Promise<Workspace>
}

export const api = {
  workspace: () => request('/workspace'),
  submit: (workDate: string, hours: number, requestId: string) =>
    request('/timecards', { workDate, hours, requestId }, 'worker'),
  resubmit: (card: Timecard, workDate: string, hours: number) =>
    request(`/timecards/${encodeURIComponent(card.id)}/resubmit`, { workDate, hours, version: card.version }, 'worker'),
  decide: (card: Timecard, decision: 'approve' | 'return', reason?: string) =>
    request(`/timecards/${encodeURIComponent(card.id)}/decision`, { decision, reason, version: card.version }, 'foreman'),
  reset: () => request('/reset', {}),
}

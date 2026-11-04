import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { type Fixtures, seedHistory, transaction } from './db.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string,
    public readonly code?: 'workspace_required' | 'workspace_changed' | 'workspace_expired') {
    super(message);
  }
}

const projectCalendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });

const cardFields = {
  workDate: z.iso.date().refine((date) => {
    const parts = projectCalendar.formatToParts(new Date());
    const today = ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
    return date >= '2000-01-01' && date <= today;
  }, 'Choose a work date on or before today.'),
  hours: z.number().min(0.01).max(24).multipleOf(0.01, 'Enter hours with at most two decimal places.'),
};

const version = z.int().min(1).max(25);
export const cardId = z.uuid();
export const submitInput = z.strictObject({ ...cardFields, requestId: z.uuid() });
export const resubmitInput = z.strictObject({ ...cardFields, version });
export const decisionInput = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('approve'), version, reason: z.literal('').optional() }),
  z.strictObject({ decision: z.literal('return'), version, reason: z.string().trim().min(1).max(500)
    .refine((reason) => !/[\u0000\uD800-\uDFFF]/u.test(reason), 'Enter a return reason using valid text.') }),
]);

const MAX_SESSIONS = 1000;
const MAX_CARDS = 125;

interface AuditEvent {
  action: 'submitted' | 'returned' | 'resubmitted' | 'approved';
  actor: string;
  at: string;
  note: string | null;
}

interface Timecard {
  id: string;
  workerName: string;
  workDate: string;
  hours: number;
  status: 'pending' | 'returned' | 'approved';
  version: number;
  submittedAt: string;
  decisionAt: string | null;
  decisionBy: string | null;
  reason: string | null;
  costCents: number | null;
  rateCents: number | null;
  audit: AuditEvent[];
}

export interface Workspace {
  workspaceId: string;
  affectedCardId?: string;
  project: { id: string; name: string; code: string; location: string; budgetCents: number; approvedCents: number; pendingCents: number };
  worker: { name: string };
  foreman: { name: string };
  manager: { name: string };
  timecards: Timecard[];
}

export async function readWorkspace(db: Pool | PoolClient, session: string, fixtures: Fixtures): Promise<Workspace | undefined> {
  const result = await db.query<{ workspace: Workspace }>(`
    WITH visible_cards AS (
      SELECT card.id, worker.name AS "workerName", to_char(card.work_date, 'YYYY-MM-DD') AS "workDate", card.hours,
        card.status, card.version, card.submitted_at AS "submittedAt", card.decision_at AS "decisionAt",
        reviewer.name AS "decisionBy", card.reason,
        COALESCE(card.approved_rate_cents, rate.rate_cents) AS "rateCents",
        COALESCE(card.approved_cost_cents, round(card.hours * rate.rate_cents)::integer) AS "costCents",
        COALESCE(history.events, '[]'::json) AS audit
      FROM timecards card
      JOIN people worker ON worker.id = card.worker_id
      LEFT JOIN people reviewer ON reviewer.id = card.decision_by
      LEFT JOIN LATERAL (
        SELECT rate_cents FROM labour_rates
        WHERE project_id = card.project_id AND worker_id = card.worker_id AND effective_from <= card.work_date
        ORDER BY effective_from DESC LIMIT 1
      ) rate ON card.status <> 'approved'
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('action', event.action, 'actor', actor.name, 'at', event.occurred_at, 'note', event.note)
          ORDER BY event.occurred_at, event.id) AS events
        FROM audit_events event JOIN people actor ON actor.id = event.actor_id
        WHERE event.timecard_id = card.id
      ) history ON true
      WHERE card.session_id = $1
    ), card_totals AS (
      SELECT COALESCE(sum("costCents") FILTER (WHERE status = 'approved'), 0) AS approved,
        COALESCE(sum("costCents") FILTER (WHERE status = 'pending'), 0) AS pending,
        COALESCE(json_agg(visible_cards ORDER BY "workDate" DESC, "submittedAt" DESC, id), '[]'::json) AS cards
      FROM visible_cards
    )
    SELECT json_build_object(
      'workspaceId', session.workspace_id,
      'project', json_build_object('id', project.id, 'name', project.name, 'code', project.code, 'location', project.location,
        'budgetCents', project.budget_cents, 'approvedCents', card_totals.approved, 'pendingCents', card_totals.pending),
      'worker', json_build_object('name', worker.name), 'foreman', json_build_object('name', foreman.name),
      'manager', json_build_object('name', manager.name), 'timecards', card_totals.cards
    ) AS workspace
    FROM demo_sessions session JOIN projects project ON project.id = session.project_id
    CROSS JOIN card_totals
    JOIN people worker ON worker.id = $2
    JOIN people foreman ON foreman.id = $3
    JOIN people manager ON manager.id = $4
    WHERE session.id = $1 AND session.expires_at > now()
  `, [session, fixtures.worker.id, fixtures.foreman.id, fixtures.manager.id]);
  return result.rows[0]?.workspace;
}

async function writtenWorkspace(client: PoolClient, session: string, fixtures: Fixtures): Promise<Workspace> {
  const workspace = await readWorkspace(client, session, fixtures);
  if (!workspace) throw new Error('The workspace could not be read after writing it.');
  return workspace;
}

export function newWorkspace(pool: Pool, session: string, fixtures: Fixtures) {
  return transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(66303401)');
    const current = await readWorkspace(client, session, fixtures);
    if (current) return current;
    await client.query('DELETE FROM demo_sessions WHERE expires_at <= now()');
    const inserted = await client.query(`
      INSERT INTO demo_sessions (id, project_id)
      SELECT $1, $2 WHERE (SELECT count(*) FROM demo_sessions) < $3
    `, [session, fixtures.project.id, MAX_SESSIONS]);
    if (inserted.rowCount !== 1) throw new ApiError(503, 'The demo is at capacity. Please try again later.');
    await seedHistory(client, session, fixtures);
    return writtenWorkspace(client, session, fixtures);
  });
}

async function mutate(
  pool: Pool, session: string, workspace: string, fixtures: Fixtures, change: (client: PoolClient) => Promise<string>,
) {
  return transaction(pool, async (client) => {
    await lockWorkspace(client, session, workspace, fixtures.project.id);
    const affectedCardId = await change(client);
    return { ...await writtenWorkspace(client, session, fixtures), affectedCardId };
  });
}

async function lockWorkspace(client: PoolClient, session: string, workspace: string, project: string) {
  // Serialize edits, retries and resets from separate tabs.
  const active = await client.query<{ workspace_id: string; reset_throttled: boolean | null }>(`
    SELECT workspace_id, last_reset_at > now() - interval '3 seconds' AS reset_throttled
    FROM demo_sessions WHERE id = $1 AND project_id = $2 AND expires_at > now() FOR UPDATE
  `, [session, project]);
  if (!active.rows[0]) throw new ApiError(409, 'This demo session ended. Reload the workspace to continue.', 'workspace_expired');
  if (active.rows[0].workspace_id !== workspace) {
    throw new ApiError(409, 'This demo workspace changed. Reload the workspace before making changes.', 'workspace_changed');
  }
  return active.rows[0];
}

async function verifyAssignment(client: PoolClient, project: string, actor: string, role: 'worker' | 'foreman') {
  const allowed = await client.query(`
    SELECT 1 FROM project_assignments assignment JOIN people person ON person.id = assignment.person_id
    WHERE assignment.project_id = $1 AND person.id = $2 AND person.role = $3
  `, [project, actor, role]);
  if (allowed.rowCount !== 1) throw new ApiError(403, 'This person is not assigned to the project.');
}

async function getRate(client: PoolClient, project: string, worker: string, workDate: string): Promise<number> {
  const result = await client.query<{ rate_cents: number }>(`
    SELECT rate_cents FROM labour_rates WHERE project_id = $1 AND worker_id = $2 AND effective_from <= $3
    ORDER BY effective_from DESC LIMIT 1
  `, [project, worker, workDate]);
  if (!result.rows[0]) throw new ApiError(422, 'No labour rate is configured for the work date.');
  return result.rows[0].rate_cents;
}

async function recordAction(client: PoolClient, card: string, actor: string, action: string, note: string | null = null) {
  await client.query('INSERT INTO audit_events (timecard_id, actor_id, action, note) VALUES ($1, $2, $3, $4)', [card, actor, action, note]);
}

async function verifyDailyHours(
  client: PoolClient, session: string, project: string, worker: string, workDate: string, hours: number,
  replacingId: string | null = null, counted: 'active' | 'approved' = 'active',
) {
  const { rows } = await client.query<{ allowed: boolean }>(`
    SELECT COALESCE(sum(hours), 0) + $5::numeric <= 24 AS allowed FROM timecards
    WHERE session_id = $1 AND project_id = $2 AND worker_id = $3 AND work_date = $4
      AND id IS DISTINCT FROM $6::uuid AND (status = 'approved' OR ($7 = 'active' AND status = 'pending'))
  `, [session, project, worker, workDate, hours, replacingId, counted]);
  if (!rows[0].allowed) {
    const description = counted === 'active' ? 'Pending and approved hours' : 'Approved hours';
    throw new ApiError(422, `${description} for this work date cannot exceed 24.`);
  }
}

async function lookupSubmission(client: PoolClient, session: string, requestId: string) {
  const result = await client.query<{ id: string; request_digest: string }>(`
    SELECT id, request_digest FROM timecards WHERE session_id = $1 AND request_id = $2
  `, [session, requestId]);
  return result.rows[0];
}

export function reconcileSubmission(pool: Pool, session: string, workspace: string, fixtures: Fixtures, requestId: string) {
  return transaction(pool, async (client) => {
    await lockWorkspace(client, session, workspace, fixtures.project.id);
    const existing = await lookupSubmission(client, session, requestId);
    if (!existing) throw new ApiError(404, 'This submission has not been recorded.');
    return { ...await writtenWorkspace(client, session, fixtures), affectedCardId: existing.id };
  });
}

export function submitCard(pool: Pool, session: string, workspace: string, fixtures: Fixtures, input: z.infer<typeof submitInput>) {
  const { project, worker } = fixtures;
  return mutate(pool, session, workspace, fixtures, async (client) => {
    await verifyAssignment(client, project.id, worker.id, 'worker');
    const digest = createHash('sha256').update(JSON.stringify([input.workDate, input.hours])).digest('hex');
    const existing = await lookupSubmission(client, session, input.requestId);
    if (existing) {
      if (existing.request_digest !== digest) throw new ApiError(409, 'This submission ID is already used by a different timecard.');
      return existing.id;
    }
    const count = await client.query<{ count: number }>('SELECT count(*)::integer FROM timecards WHERE session_id = $1', [session]);
    if (count.rows[0].count >= MAX_CARDS) throw new ApiError(409, 'This session is full. Reset the demo to start again.');
    await getRate(client, project.id, worker.id, input.workDate);
    await verifyDailyHours(client, session, project.id, worker.id, input.workDate, input.hours);
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO timecards (session_id, project_id, worker_id, work_date, hours, status, request_id, request_digest)
      VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING id
    `, [session, project.id, worker.id, input.workDate, input.hours, input.requestId, digest]);
    await recordAction(client, inserted.rows[0].id, worker.id, 'submitted');
    return inserted.rows[0].id;
  });
}

async function findCard(client: PoolClient, session: string, id: string, project: string) {
  const result = await client.query<{
    worker_id: string; work_date: string; hours: number; status: string; version: number; decision_by: string | null; reason: string | null;
  }>(`
    SELECT worker_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, hours::float8, status, version, decision_by, reason FROM timecards
    WHERE id = $1 AND session_id = $2 AND project_id = $3
  `, [id, session, project]);
  if (!result.rows[0]) throw new ApiError(404, 'This timecard was not found in your demo session.');
  return result.rows[0];
}

export function resubmitCard(pool: Pool, session: string, workspace: string, fixtures: Fixtures, id: string, input: z.infer<typeof resubmitInput>) {
  const { project, worker } = fixtures;
  return mutate(pool, session, workspace, fixtures, async (client) => {
    await verifyAssignment(client, project.id, worker.id, 'worker');
    const card = await findCard(client, session, id, project.id);
    if (card.worker_id !== worker.id) throw new ApiError(403, 'Only the assigned worker can resubmit this timecard.');
    if (card.version === input.version + 1 && card.status === 'pending' && card.work_date === input.workDate && card.hours === input.hours) return id;
    if (card.version !== input.version || card.status !== 'returned') throw new ApiError(409, 'This timecard has changed. Refresh before resubmitting.');
    if (card.version >= 24) throw new ApiError(409, 'This timecard reached its revision limit. Start a new timecard.');
    await getRate(client, project.id, worker.id, input.workDate);
    await verifyDailyHours(client, session, project.id, worker.id, input.workDate, input.hours, id);
    const updated = await client.query(`
      UPDATE timecards SET work_date = $2, hours = $3, status = 'pending', version = version + 1,
        submitted_at = now(), decision_at = NULL, decision_by = NULL, reason = NULL
      WHERE id = $1 AND version = $4 AND status = 'returned'
    `, [id, input.workDate, input.hours, input.version]);
    if (updated.rowCount !== 1) throw new ApiError(409, 'This timecard has changed. Refresh before resubmitting.');
    await recordAction(client, id, worker.id, 'resubmitted');
    return id;
  });
}

export function decideCard(pool: Pool, session: string, workspace: string, fixtures: Fixtures, id: string, input: z.infer<typeof decisionInput>) {
  const { project, foreman } = fixtures;
  return mutate(pool, session, workspace, fixtures, async (client) => {
    await verifyAssignment(client, project.id, foreman.id, 'foreman');
    const card = await findCard(client, session, id, project.id);
    if (card.worker_id === foreman.id) throw new ApiError(403, 'You cannot review your own timecard.');
    const status = input.decision === 'approve' ? 'approved' : 'returned';
    const reason = input.decision === 'return' ? input.reason : null;
    if (card.version === input.version + 1 && card.status === status && card.decision_by === foreman.id && card.reason === reason) return id;
    if (card.version !== input.version || card.status !== 'pending') throw new ApiError(409, 'This timecard has changed. Refresh before making a decision.');
    const rate = input.decision === 'approve' ? await getRate(client, project.id, card.worker_id, card.work_date) : null;
    if (rate !== null) await verifyDailyHours(client, session, project.id, card.worker_id, card.work_date, card.hours, id, 'approved');
    const updated = await client.query(`
      UPDATE timecards SET status = $2, version = version + 1, decision_at = now(), decision_by = $3, reason = $4,
        approved_rate_cents = $5::integer, approved_cost_cents = round(hours * $5::integer)::integer
      WHERE id = $1 AND version = $6 AND status = 'pending'
    `, [id, status, foreman.id, reason, rate, input.version]);
    if (updated.rowCount !== 1) throw new ApiError(409, 'This timecard has changed. Refresh before making a decision.');
    await recordAction(client, id, foreman.id, status, reason);
    return id;
  });
}

export function resetWorkspace(pool: Pool, session: string, workspace: string, fixtures: Fixtures) {
  return transaction(pool, async (client) => {
    const current = await lockWorkspace(client, session, workspace, fixtures.project.id);
    if (current.reset_throttled) throw new ApiError(429, 'Wait a few seconds before resetting again.');
    // Keep the secret cookie stable while invalidating the generation on every old request.
    await client.query('UPDATE demo_sessions SET workspace_id = gen_random_uuid(), last_reset_at = now() WHERE id = $1', [session]);
    await client.query('DELETE FROM timecards WHERE session_id = $1', [session]);
    await seedHistory(client, session, fixtures);
    return writtenWorkspace(client, session, fixtures);
  });
}

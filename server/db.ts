import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const label = z.string().trim().min(1).max(120);
const integer = (maximum: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(maximum));

const projectRow = z.strictObject({
  id: identifier,
  name: label,
  code: label,
  location: label,
  budget_cents: integer(100_000_000),
  demo_worker_id: identifier,
});

const personRow = z.strictObject({
  id: identifier,
  name: label,
  role: z.enum(['worker', 'foreman', 'manager']),
  project_id: identifier,
});

const rateRow = z.strictObject({
  project_id: identifier,
  worker_id: identifier,
  effective_from: z.iso.date(),
  rate_cents: integer(1_000_000),
});

const historyRow = z.strictObject({
  work_days_ago: integer(365),
  worker_id: identifier,
  hours: z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).transform(Number).pipe(z.number().gt(0).max(24)),
});

async function readFixture<T>(directory: URL, filename: string, schema: z.ZodType<T>): Promise<T[]> {
  const file = await readFile(new URL(filename, directory), 'utf8');
  let rows: unknown[];
  try {
    rows = parse(file, { columns: true, bom: true, skip_empty_lines: true });
  } catch (error) {
    throw new Error(`${filename}: ${error instanceof Error ? error.message : 'invalid CSV'}`, { cause: error });
  }
  if (rows.length === 0) throw new Error(`${filename} must contain at least one row.`);
  const data: T[] = [];
  const issues: string[] = [];
  for (const [index, row] of rows.entries()) {
    const result = schema.safeParse(row);
    if (result.success) data.push(result.data);
    else issues.push(`${filename}, record ${index + 1}: ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', ')}`);
  }
  if (issues.length > 0) throw new Error(issues.join('\n'));
  return data;
}

function ensureUnique<T>(rows: T[], key: (row: T) => string | number, filename: string) {
  const seen = new Set<string | number>();
  for (const [index, row] of rows.entries()) {
    const value = key(row);
    if (seen.has(value)) throw new Error(`${filename}, record ${index + 1}: duplicate key ${value}.`);
    seen.add(value);
  }
}

async function readFixtures(directory: URL) {
  const [projects, people, rates, history] = await Promise.all([
    readFixture(directory, 'projects.csv', projectRow),
    readFixture(directory, 'people.csv', personRow),
    readFixture(directory, 'rates.csv', rateRow),
    readFixture(directory, 'history.csv', historyRow),
  ]);
  const project = projects[0];
  if (!project || projects.length !== 1) throw new Error('projects.csv must contain one demo project.');
  const workers = people.filter((person) => person.role === 'worker');
  const workerIds = new Set(workers.map((person) => person.id));
  ensureUnique(people, (person) => person.id, 'people.csv');
  ensureUnique(people.filter((person) => person.role !== 'worker'), (person) => person.role, 'people.csv');
  ensureUnique(rates, (rate) => `${rate.project_id}:${rate.worker_id}:${rate.effective_from}`, 'rates.csv');
  ensureUnique(history, (row) => `${row.worker_id}:${row.work_days_ago}`, 'history.csv');

  const worker = workers.find((person) => person.id === project.demo_worker_id);
  const foreman = people.find((person) => person.role === 'foreman');
  const manager = people.find((person) => person.role === 'manager');
  if (!worker || !foreman || !manager || people.some((person) => person.project_id !== project.id)) {
    throw new Error('people.csv must assign the designated demo worker, a foreman and a manager to the demo project.');
  }
  const baselineWorkers = new Set(rates.filter((rate) => rate.effective_from === '2000-01-01').map((rate) => rate.worker_id));
  if (workers.some((person) => !baselineWorkers.has(person.id)) || rates.some((rate) => rate.project_id !== project.id || !workerIds.has(rate.worker_id))) {
    throw new Error('rates.csv must include a baseline rate dated 2000-01-01 for each assigned worker and refer only to assigned workers.');
  }
  if (history.some((row) => !workerIds.has(row.worker_id))) {
    throw new Error('history.csv must refer to assigned workers.');
  }
  return { project, people, rates, history, worker, foreman, manager };
}

export type Fixtures = Awaited<ReturnType<typeof readFixtures>>;

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { discardClient = true; });
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function prepareDatabase(pool: Pool, fixtureDirectory = new URL('./fixtures/', import.meta.url)): Promise<Fixtures> {
  const [schema, fixtures] = await Promise.all([
    readFile(new URL('./schema.sql', import.meta.url), 'utf8'),
    readFixtures(fixtureDirectory),
  ]);
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(66303400)');
    await client.query(schema);
    // Fixtures fill missing reference keys. Existing records remain canonical on subsequent starts.
    const { project, people, rates } = fixtures;
    await client.query(
      'INSERT INTO projects (id, name, code, location, budget_cents) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
      [project.id, project.name, project.code, project.location, project.budget_cents],
    );
    for (const person of people) {
      await client.query('INSERT INTO people (id, name, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [person.id, person.name, person.role]);
      await client.query('INSERT INTO project_assignments (project_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [project.id, person.id]);
    }
    for (const rate of rates) {
      await client.query(
        'INSERT INTO labour_rates (project_id, worker_id, effective_from, rate_cents) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [rate.project_id, rate.worker_id, rate.effective_from, rate.rate_cents],
      );
    }
  });
  return fixtures;
}

export async function seedHistory(client: PoolClient, session: string, fixtures: Fixtures) {
  const seeded = await client.query(`
    WITH historical_shifts AS (
      SELECT (now() AT TIME ZONE 'America/Toronto')::date - work_days_ago AS work_date, worker_id, hours,
        (row_number() OVER (PARTITION BY work_days_ago ORDER BY worker_id) - 1) * interval '7 minutes' AS time_offset
      FROM jsonb_to_recordset($4::jsonb) AS imported(work_days_ago integer, worker_id text, hours numeric)
    ), cards AS (
      INSERT INTO timecards (session_id, project_id, worker_id, work_date, hours, status, version,
        submitted_at, decision_at, decision_by, approved_rate_cents, approved_cost_cents)
      SELECT $1, $2, shift.worker_id, shift.work_date, shift.hours, 'approved', 2,
        (shift.work_date + time '17:00' + shift.time_offset) AT TIME ZONE 'America/Toronto',
        (shift.work_date + time '18:30' + shift.time_offset) AT TIME ZONE 'America/Toronto',
        $3, rate.rate_cents, round(shift.hours * rate.rate_cents)::integer
      FROM historical_shifts shift
      CROSS JOIN LATERAL (
        SELECT rate_cents FROM labour_rates
        WHERE project_id = $2 AND worker_id = shift.worker_id AND effective_from <= shift.work_date
        ORDER BY effective_from DESC LIMIT 1
      ) rate
      RETURNING id, worker_id, work_date, hours, submitted_at, decision_at
    )
    INSERT INTO audit_events (timecard_id, actor_id, action, occurred_at, work_date, hours)
    SELECT id, worker_id, 'submitted', submitted_at, work_date, hours FROM cards
    UNION ALL
    SELECT id, $3, 'approved', decision_at, NULL, NULL FROM cards
  `, [session, fixtures.project.id, fixtures.foreman.id, JSON.stringify(fixtures.history)]);
  if (seeded.rowCount !== fixtures.history.length * 2) throw new Error('Every historical shift must have a persisted labour rate.');
}

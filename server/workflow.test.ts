import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { prepareDatabase } from './db.js';
import type { Workspace } from './workspace.js';

test('field timecards against PostgreSQL', async (context) => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(connectionString, 'Set DATABASE_URL or TEST_DATABASE_URL to run PostgreSQL integration tests.');
  const schema = `fieldledger_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  context.after(async () => {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  const fixtures = await prepareDatabase(pool);
  await prepareDatabase(pool);
  const server = createApp(pool, fixtures, { origin: 'https://fieldledger.example', secureCookies: true }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  function browser() {
    let cookie = '';
    let workspaceId = '';
    return async (endpoint: string, options?: {
      body?: unknown; role?: string; origin?: string; cookie?: string; workspace?: string | null; fetchSite?: string;
    }) => {
      const headers = new Headers();
      const sentCookie = options?.cookie ?? cookie;
      const sentWorkspace = options?.workspace === null ? '' : options?.workspace ?? workspaceId;
      if (sentCookie) headers.set('Cookie', sentCookie);
      if (sentWorkspace) headers.set('X-Demo-Workspace', sentWorkspace);
      if (options?.body !== undefined) headers.set('Content-Type', 'application/json');
      if (options?.role) headers.set('X-Demo-Role', options.role);
      if (options?.origin) headers.set('Origin', options.origin);
      if (options?.fetchSite) headers.set('Sec-Fetch-Site', options.fetchSite);
      const response = await fetch(`${base}${endpoint}`, { method: options?.body !== undefined ? 'POST' : 'GET', headers, body: JSON.stringify(options?.body) });
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie) {
        assert.match(setCookie, /^__Host-fieldledger=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /; Secure(?:;|$)/i);
        assert.match(setCookie, /; Path=\/(?:;|$)/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.match(setCookie, /; Max-Age=86400(?:;|$)/i);
        cookie = setCookie.split(';')[0];
      }
      const data = await response.json();
      if (response.ok && data.workspaceId) workspaceId = data.workspaceId;
      return { status: response.status, data: data as Workspace, code: data.code as string | undefined, sentCookie, sentWorkspace, setCookie };
    };
  }

  const first = browser();
  const second = browser();
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
  const workDate = calendar.format(new Date());
  const submit = { workDate, hours: 8, requestId: randomUUID() };
  let id: string;

  await context.test('migrates an existing database without deleting legacy over-limit pending cards', async () => {
    const legacy = browser();
    const original = await legacy('/workspace');
    const originalSession = original.setCookie?.split(';')[0].split('=')[1];
    assert.ok(originalSession);
    await pool.query('ALTER TABLE demo_sessions DROP COLUMN workspace_id');
    await pool.query(`
      INSERT INTO timecards (session_id, project_id, worker_id, work_date, hours, status)
      SELECT $1, $2, $3, $4, 24, 'pending' FROM generate_series(1, 2)
    `, [originalSession, fixtures.project.id, fixtures.worker.id, workDate]);
    await prepareDatabase(pool);
    await prepareDatabase(pool);
    const migrated = await legacy('/workspace');
    assert.equal(migrated.status, 200);
    assert.equal(migrated.setCookie, null);
    assert.notEqual(migrated.data.workspaceId, original.data.workspaceId);
    assert.equal(migrated.data.project.approvedCents, 970_000);
    assert.equal(migrated.data.project.pendingCents, 240_000);
    const [allowed, blocked] = migrated.data.timecards.filter((card) => card.status === 'pending');
    const decision = { role: 'foreman', body: { decision: 'approve', version: 1 } };
    assert.equal((await legacy(`/timecards/${allowed.id}/decision`, decision)).status, 200);
    assert.equal((await legacy(`/timecards/${blocked.id}/decision`, decision)).status, 422);
    assert.equal((await legacy('/workspace')).data.project.approvedCents, 1_090_000);
  });

  await context.test('starts separate durable sessions with CAD 9,700 approved', async () => {
    const [original, other] = await Promise.all([first('/workspace'), second('/workspace')]);
    assert.equal(original.status, 200);
    assert.equal(original.data.project.budgetCents, 1_000_000);
    assert.equal(original.data.project.approvedCents, 970_000);
    assert.equal(original.data.project.pendingCents, 0);
    assert.equal(original.data.timecards.length, 25);
    assert.equal(other.data.project.approvedCents, 970_000);
    assert.notEqual(original.data.workspaceId, other.data.workspaceId);
    assert.notEqual(original.data.workspaceId, original.setCookie?.split(';')[0].split('=')[1]);
    assert.notEqual(original.data.timecards[0].id, other.data.timecards[0].id);
    assert.deepEqual((await first('/workspace')).data, original.data);
  });

  await context.test('validates inputs, permissions and client retries', async () => {
    const crossSite = browser();
    for (const route of ['/workspace', '/workspace/', '/WORKSPACE']) {
      const rejected = await crossSite(route, { fetchSite: 'cross-site' });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.setCookie, null);
    }
    assert.equal((await first('/timecards', { role: 'manager', body: submit })).status, 403);
    assert.equal((await first('/timecards', { role: 'worker', origin: 'https://unrelated.example', body: submit })).status, 403);
    const outdated = await first('/timecards', { role: 'worker', body: submit, workspace: null });
    assert.equal(outdated.status, 409);
    assert.equal(outdated.code, 'workspace_required');
    assert.equal((await first('/timecards', { role: 'worker', body: { ...submit, hours: 8.001 } })).status, 400);
    assert.equal((await first('/timecards', { role: 'worker', body: { ...submit, workDate: '2025-02-30' } })).status, 400);
    assert.equal((await first('/timecards', { role: 'worker', body: { ...submit, workDate: '2099-01-01' } })).status, 400);
    assert.equal((await first(`/timecards/submissions/${submit.requestId}`)).status, 404);
    const [created, retried] = await Promise.all([
      first('/timecards', { role: 'worker', body: submit }), first('/timecards', { role: 'worker', body: submit }),
    ]);
    assert.equal(created.status, 200);
    assert.equal(retried.status, 200);
    assert.equal(created.data.project.pendingCents, 40_000);
    assert.equal(created.data.project.approvedCents, 970_000);
    const card = created.data.timecards.find((timecard) => timecard.status === 'pending');
    assert.ok(card);
    id = card.id;
    assert.equal(card.version, 1);
    assert.equal(card.hours, 8);
    assert.equal(card.costCents, 40_000);
    assert.equal(card.rateCents, 5000);
    assert.equal(created.data.affectedCardId, card.id);
    assert.equal(retried.data.affectedCardId, card.id);
    assert.equal(card.audit.length, 1);
    assert.equal(retried.data.timecards.filter((timecard) => timecard.status === 'pending').length, 1);
    assert.equal((await first(`/timecards/submissions/${submit.requestId}`)).data.affectedCardId, id);
    assert.equal((await second(`/timecards/submissions/${submit.requestId}`)).status, 404);
    assert.equal((await first('/timecards', { role: 'worker', body: { ...submit, hours: 9 } })).status, 409);
    assert.equal((await second(`/timecards/${id}/decision`, { role: 'foreman', body: { decision: 'approve', version: 1 } })).status, 404);
    assert.equal((await second('/workspace')).data.project.pendingCents, 0);
  });

  await context.test('returns, corrects and approves once, preserving the audit trail', async () => {
    const endpoint = `/timecards/${id}/decision`;
    assert.equal((await first(endpoint, { role: 'worker', body: { decision: 'approve', version: 1 } })).status, 403);
    assert.equal((await first(endpoint, { role: 'foreman', body: { decision: 'return', version: 1, reason: ' ' } })).status, 400);
    for (const reason of ['invalid\u0000text', 'invalid\ud800text', 'invalid\udffftext']) {
      assert.equal((await first(endpoint, { role: 'foreman', body: { decision: 'return', version: 1, reason } })).status, 400);
    }
    const reason = 'Please confirm the recorded hours. 📝';
    const decision = { role: 'foreman', body: { decision: 'return', version: 1, reason } };
    const returned = await first(endpoint, decision);
    assert.equal(returned.status, 200);
    assert.equal(returned.data.affectedCardId, id);
    assert.equal((await first(endpoint, decision)).data.affectedCardId, id);
    assert.equal(returned.data.project.pendingCents, 0);
    assert.equal(returned.data.timecards.find((card) => card.id === id)?.reason, reason);
    assert.equal((await first(endpoint, { role: 'foreman', body: { decision: 'approve', version: 1 } })).status, 409);
    const corrected = await first(`/timecards/${id}/resubmit`, { role: 'worker', body: { workDate, hours: 8, version: 2 } });
    assert.equal(corrected.status, 200);
    assert.equal(corrected.data.affectedCardId, id);
    assert.equal(corrected.data.timecards.find((card) => card.id === id)?.version, 3);
    assert.equal(corrected.data.project.pendingCents, 40_000);
    const approval = { role: 'foreman', body: { decision: 'approve', version: 3 } };
    const [approved, duplicate] = await Promise.all([first(endpoint, approval), first(endpoint, approval)]);
    assert.equal(approved.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.affectedCardId, id);
    assert.equal(approved.data.project.pendingCents, 0);
    assert.equal(approved.data.project.approvedCents, 1_010_000);
    assert.equal(duplicate.data.project.approvedCents, 1_010_000);
    const card = approved.data.timecards.find((candidate) => candidate.id === id);
    assert.ok(card);
    assert.equal(card.status, 'approved');
    assert.equal(card.decisionBy, 'Lucas Martin');
    assert.equal(card.costCents, 40_000);
    assert.deepEqual(card.audit.map((event) => event.action), ['submitted', 'returned', 'resubmitted', 'approved']);
    assert.equal(card.audit[1].note, reason);
    assert.equal((await first('/workspace')).data.project.approvedCents, 1_010_000);
  });

  await context.test('caps daily pending and approved hours across concurrent submissions and corrections', async () => {
    const client = browser();
    const initial = await client('/workspace');
    function send(hours: number) {
      return client('/timecards', { role: 'worker', body: { workDate, hours, requestId: randomUUID() } });
    }
    const race = await Promise.all([send(15), send(15)]);
    assert.deepEqual(race.map((result) => result.status).sort(), [200, 422]);
    const winner = race.find((result) => result.status === 200)?.data.affectedCardId;
    assert.ok(winner);
    assert.equal((await send(9)).data.project.pendingCents, 120_000);
    assert.equal((await send(0.01)).status, 422);
    const returned = await client(`/timecards/${winner}/decision`, { role: 'foreman', body: { decision: 'return', reason: 'Check date', version: 1 } });
    assert.equal(returned.data.project.pendingCents, 45_000);
    assert.equal((await send(12)).data.project.pendingCents, 105_000);
    assert.equal((await client(`/timecards/${winner}/resubmit`, { role: 'worker', body: { workDate, hours: 4, version: 2 } })).status, 422);

    const otherDate = initial.data.timecards.find((card) => card.hours === 8)?.workDate;
    assert.ok(otherDate);
    const correction = { role: 'worker', body: { workDate: otherDate, hours: 16, version: 2 } };
    assert.equal((await client(`/timecards/${winner}/resubmit`, correction)).status, 200);
    assert.equal((await client(`/timecards/${winner}/resubmit`, correction)).data.affectedCardId, winner);
  });

  await context.test('preserves approved history after a rate change and resets one browser', async () => {
    await pool.query('UPDATE labour_rates SET rate_cents = 6000 WHERE project_id = $1', [fixtures.project.id]);
    const later = await first('/timecards', { role: 'worker', body: { workDate, hours: 2.25, requestId: randomUUID() } });
    assert.equal(later.status, 200);
    assert.equal(later.data.project.pendingCents, 13_500);
    assert.equal(later.data.project.approvedCents, 1_010_000);
    assert.equal(later.data.timecards.find((card) => card.id === id)?.costCents, 40_000);
    assert.equal(later.data.timecards.find((card) => card.id === id)?.rateCents, 5000);
    assert.equal(later.data.timecards.find((card) => card.id === later.data.affectedCardId)?.rateCents, 6000);
    const beforeReset = await second('/workspace');
    const reset = await first('/reset', { body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.setCookie, null);
    assert.notEqual(reset.data.workspaceId, reset.sentWorkspace);
    assert.equal(reset.data.project.approvedCents, 970_000);
    assert.equal(reset.data.project.pendingCents, 0);
    assert.ok(!reset.data.timecards.some((card) => card.id === id));
    const oldWrite = await first('/timecards', { role: 'worker', cookie: reset.sentCookie, workspace: reset.sentWorkspace, body: submit });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.code, 'workspace_changed');
    const staleRead = await first('/workspace', { cookie: reset.sentCookie, workspace: reset.sentWorkspace });
    assert.equal(staleRead.setCookie, null);
    assert.equal(staleRead.data.workspaceId, reset.data.workspaceId);
    assert.equal((await first('/reset', { body: {} })).status, 429);
    assert.deepEqual((await second('/workspace')).data, beforeReset.data);
  });

  await context.test('recovers an expired workspace without rewriting an existing browser cookie', async () => {
    const expired = browser();
    const original = await expired('/workspace');
    const session = original.setCookie?.split(';')[0].split('=')[1];
    assert.ok(session);
    await pool.query(`UPDATE demo_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [session]);
    const stopped = await expired('/timecards', { role: 'worker', body: submit });
    assert.equal(stopped.status, 409);
    assert.equal(stopped.code, 'workspace_expired');
    const [recovered, concurrent] = await Promise.all([expired('/workspace'), expired('/workspace')]);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.setCookie, null);
    assert.equal(concurrent.setCookie, null);
    assert.notEqual(recovered.data.workspaceId, original.data.workspaceId);
    assert.equal(recovered.data.workspaceId, concurrent.data.workspaceId);
    assert.equal(recovered.data.project.approvedCents, 970_000);
  });

  await context.test('rolls back the approval if writing its audit record fails', async (subtest) => {
    const created = await second('/timecards', { role: 'worker', body: { workDate, hours: 8, requestId: randomUUID() } });
    const pending = created.data.timecards.find((card) => card.status === 'pending');
    assert.ok(pending);
    await pool.query(`
      CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test audit failure'; END $$;
      CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events FOR EACH ROW
        WHEN (NEW.action = 'approved') EXECUTE FUNCTION reject_audit();
    `);
    subtest.mock.method(console, 'error', () => undefined);
    const attempt = await second(`/timecards/${pending.id}/decision`, { role: 'foreman', body: { decision: 'approve', version: pending.version } });
    assert.equal(attempt.status, 500);
    const after = await second('/workspace');
    assert.equal(after.data.project.approvedCents, 970_000);
    assert.equal(after.data.project.pendingCents, 48_000);
    assert.deepEqual(after.data.timecards.find((card) => card.id === pending.id), pending);
  });
});

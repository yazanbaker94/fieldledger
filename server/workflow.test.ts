import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { prepareDatabase } from './db.js';
import { newWorkspace, readWorkspace, submitCard, type Workspace } from './workspace.js';

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
      body?: unknown; role?: string; origin?: string; cookie?: string; workspace?: string | null; fetchSite?: string; idempotencyKey?: string;
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
      if (options?.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
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
    await pool.query('ALTER TABLE audit_events DROP COLUMN work_date, DROP COLUMN hours, DROP COLUMN previous_work_date, DROP COLUMN previous_hours');
    await pool.query('DROP TABLE timecard_correction_receipts');
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
    const existingSubmission = migrated.data.timecards.find((card) => card.status === 'approved')?.audit[0];
    assert.ok(existingSubmission);
    assert.equal(existingSubmission.action, 'submitted');
    assert.equal(existingSubmission.workDate, null);
    assert.equal(existingSubmission.hours, null);
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
    assert.equal(original.data.timecards[0].audit[0].workDate, original.data.timecards[0].workDate);
    assert.equal(original.data.timecards[0].audit[0].hours, original.data.timecards[0].hours);
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

  await context.test('discards unsaved submissions atomically and reports any submission that already saved', async () => {
    const client = browser();
    const before = await client('/workspace');
    const draft = { workDate, hours: 8, requestId: randomUUID() };
    const receipt = `/timecards/submissions/${draft.requestId}`;
    const worker = { role: 'worker' };

    assert.equal((await client(receipt)).status, 404);
    assert.equal((await client(`${receipt}/discard`, { role: 'foreman', body: {} })).status, 403);
    const discarded = await client(`${receipt}/discard`, { ...worker, body: {} });
    assert.equal(discarded.status, 200);
    assert.equal(discarded.data.affectedCardId, undefined);
    assert.equal(discarded.data.project.pendingCents, 0);
    assert.equal((await client(`${receipt}/discard`, { ...worker, body: {} })).status, 200);
    const late = await client('/timecards', { ...worker, body: draft });
    assert.equal(late.status, 409);
    assert.equal(late.code, 'submission_discarded');
    assert.equal((await client(receipt)).status, 410);
    assert.equal((await second(receipt)).status, 404);

    const revised = { ...draft, hours: 7, requestId: randomUUID() };
    const saved = await client('/timecards', { ...worker, body: revised });
    assert.equal(saved.status, 200);
    const alreadySaved = await client(`/timecards/submissions/${revised.requestId}/discard`, { ...worker, body: {} });
    assert.equal(alreadySaved.status, 200);
    assert.equal(alreadySaved.data.affectedCardId, saved.data.affectedCardId);
    assert.equal(alreadySaved.data.project.pendingCents, 35_000);

    assert.equal((await client('/reset', { body: {} })).status, 200);
    assert.equal((await client(receipt)).status, 404);
    assert.equal((await client('/timecards', { ...worker, workspace: before.data.workspaceId, body: draft })).code, 'workspace_changed');
  });

  await context.test('returns, corrects and approves once, preserving the audit trail', async () => {
    const endpoint = `/timecards/${id}/decision`;
    assert.equal((await first(endpoint, { role: 'worker', body: { decision: 'approve', version: 1 } })).status, 403);
    assert.equal((await first(endpoint, { role: 'foreman', body: { decision: 'return', version: 1, reason: ' ' } })).status, 400);
    for (const reason of ['invalid\u0000text', 'invalid\ud800text', 'invalid\udffftext', '\u200b\ufe0f']) {
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

  await context.test('keeps correction receipts and audit inputs through later revisions', async () => {
    const client = browser();
    const initial = await client('/workspace');
    const firstRequestId = randomUUID();
    const created = await client('/timecards', { role: 'worker', body: { workDate, hours: 8, requestId: firstRequestId } });
    const cardId = created.data.affectedCardId;
    assert.ok(cardId);
    const decision = `/timecards/${cardId}/decision`;
    const resubmit = `/timecards/${cardId}/resubmit`;
    assert.equal((await client(decision, { role: 'foreman', body: { decision: 'return', version: 1, reason: 'Correct the date and duration' } })).status, 200);
    const correctionId = randomUUID();
    const firstCorrection = { role: 'worker', body: { workDate: initial.data.timecards[0].workDate, hours: 6, version: 2, requestId: correctionId } };
    assert.equal((await client(`/timecards/submissions/${correctionId}`)).status, 404);
    assert.equal((await client(resubmit, { ...firstCorrection, body: { ...firstCorrection.body, requestId: firstRequestId } })).status, 409);
    const { requestId, ...correctionBody } = firstCorrection.body;
    const byHeader = { role: 'worker', body: correctionBody, idempotencyKey: requestId };
    assert.equal((await client(resubmit, { ...firstCorrection, idempotencyKey: randomUUID() })).status, 400);
    const [corrected, duplicate] = await Promise.all([client(resubmit, byHeader), client(resubmit, firstCorrection)]);
    assert.equal(corrected.data.affectedCardId, cardId);
    assert.equal(duplicate.data.affectedCardId, cardId);
    assert.equal((await client(decision, { role: 'foreman', body: { decision: 'return', version: 3, reason: 'Use the original date' } })).status, 200);
    const secondCorrection = { role: 'worker', body: { workDate, hours: 7, version: 4, requestId: randomUUID() } };
    assert.equal((await client(resubmit, secondCorrection)).status, 200);
    assert.equal((await client(decision, { role: 'foreman', body: { decision: 'approve', version: 5 } })).status, 200);
    const replay = await client(resubmit.toUpperCase(), firstCorrection);
    const reconciled = await client(`/timecards/submissions/${correctionId}`);
    assert.equal(replay.data.affectedCardId, cardId);
    assert.deepEqual(reconciled.data, replay.data);
    assert.equal((await second(`/timecards/submissions/${correctionId}`)).status, 404);
    assert.equal((await client(resubmit, { ...firstCorrection, body: { ...firstCorrection.body, hours: 5 } })).status, 409);
    assert.equal((await client('/timecards', { role: 'worker', body: { workDate, hours: 8, requestId: correctionId } })).status, 409);

    const card = replay.data.timecards.find((candidate) => candidate.id === cardId);
    assert.ok(card);
    assert.equal(card.status, 'approved');
    assert.deepEqual(card.audit.map(({ action, previousWorkDate, previousHours, workDate: date, hours }) => [action, previousWorkDate, previousHours, date, hours]), [
      ['submitted', null, null, workDate, 8],
      ['returned', null, null, null, null],
      ['resubmitted', workDate, 8, firstCorrection.body.workDate, 6],
      ['returned', null, null, null, null],
      ['resubmitted', firstCorrection.body.workDate, 6, workDate, 7],
      ['approved', null, null, null, null],
    ]);
    assert.equal((await client('/reset', { body: {} })).status, 200);
    assert.equal((await client(`/timecards/submissions/${correctionId}`)).status, 404);
    assert.equal((await pool.query('SELECT 1 FROM timecard_correction_receipts WHERE request_id = $1', [correctionId])).rowCount, 0);
  });

  await context.test('recovers the last legacy return and reserves the final revision for approval', async () => {
    const client = browser();
    await client('/workspace');
    const created = await client('/timecards', { role: 'worker', body: { workDate, hours: 8, requestId: randomUUID() } });
    const cardId = created.data.affectedCardId;
    assert.ok(cardId);
    const decision = `/timecards/${cardId}/decision`;
    const resubmit = `/timecards/${cardId}/resubmit`;
    const card = (workspace: Workspace) => workspace.timecards.find((entry) => entry.id === cardId);
    const returnCard = (version: number) => client(decision, { role: 'foreman', body: { decision: 'return', version, reason: 'Confirm the duration' } });
    const correctCard = (version: number) => client(resubmit, { role: 'worker', body: { workDate, hours: 8, version, requestId: randomUUID() } });

    for (let version = 1; version < 23; version += 2) {
      assert.equal((await returnCard(version)).status, 200);
      assert.equal((await correctCard(version + 1)).status, 200);
    }
    assert.equal(card((await client('/workspace')).data)?.canReturn, true);
    // Recreate the old constraint around a return that the previous API left at version 24.
    await pool.query(`ALTER TABLE timecards DROP CONSTRAINT timecards_revision_limit,
      ADD CONSTRAINT timecards_version_check CHECK (version BETWEEN 1 AND 25)`);
    assert.equal(card((await returnCard(23)).data)?.version, 24);
    await prepareDatabase(pool);
    await prepareDatabase(pool);

    const corrected = await correctCard(24);
    assert.equal(corrected.status, 200);
    assert.equal(card(corrected.data)?.version, 25);
    assert.equal(card(corrected.data)?.canReturn, false);
    assert.equal((await returnCard(25)).status, 409);
    assert.deepEqual(card((await client('/workspace')).data), card(corrected.data));
    // The migrated database also protects the final slot if older code tries to return the card.
    await assert.rejects(pool.query(`UPDATE timecards SET status = 'returned', version = 26, decision_at = now(),
      decision_by = $2, reason = 'Another correction' WHERE id = $1`, [cardId, fixtures.foreman.id]),
    { constraint: 'timecards_revision_limit' });

    const approval = { role: 'foreman', body: { decision: 'approve', version: 25 } };
    const approved = await client(decision, approval);
    assert.equal(approved.status, 200);
    assert.equal(approved.data.project.approvedCents, 1_010_000);
    assert.equal(card(approved.data)?.version, 26);
    assert.equal(card(approved.data)?.audit.length, 26);
    assert.deepEqual((await client(decision, approval)).data, approved.data);
  });

  await context.test('rolls back correction and audit when the receipt cannot be recorded', async (subtest) => {
    const client = browser();
    await client('/workspace');
    const created = await client('/timecards', { role: 'worker', body: { workDate, hours: 8, requestId: randomUUID() } });
    const cardId = created.data.affectedCardId;
    assert.ok(cardId);
    const returned = await client(`/timecards/${cardId}/decision`, { role: 'foreman', body: { decision: 'return', version: 1, reason: 'Confirm the duration' } });
    assert.equal(returned.status, 200);
    await pool.query(`
      CREATE FUNCTION reject_correction_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test receipt failure'; END $$;
      CREATE TRIGGER reject_correction_receipt BEFORE INSERT ON timecard_correction_receipts FOR EACH ROW
        EXECUTE FUNCTION reject_correction_receipt();
    `);
    subtest.after(() => pool.query('DROP TRIGGER reject_correction_receipt ON timecard_correction_receipts; DROP FUNCTION reject_correction_receipt()').then(() => undefined));
    subtest.mock.method(console, 'error', () => undefined);
    const requestId = randomUUID();
    assert.equal((await client(`/timecards/${cardId}/resubmit`, { role: 'worker', body: { workDate, hours: 6, version: 2, requestId } })).status, 500);
    assert.equal((await client(`/timecards/submissions/${requestId}`)).status, 404);
    const current = await client('/workspace');
    assert.deepEqual(current.data.timecards.find((card) => card.id === cardId), returned.data.timecards.find((card) => card.id === cardId));
  });

  await context.test('seeds historical costs from persisted rates after fixture updates and across effective dates', async (subtest) => {
    const directory = await mkdtemp(join(tmpdir(), 'fieldledger-test-fixtures-'));
    const files = ['history.csv', 'people.csv', 'projects.csv', 'rates.csv'];
    subtest.after(async () => {
      for (const file of files) await unlink(join(directory, file)).catch(() => undefined);
      await rmdir(directory);
    });
    await Promise.all(files.map((file) => copyFile(new URL(`./fixtures/${file}`, import.meta.url), join(directory, file))));
    const rateFixture = join(directory, 'rates.csv');
    await writeFile(rateFixture, (await readFile(rateFixture, 'utf8')).replace(',5000', ',6000'));
    const changedFixtures = await prepareDatabase(pool, pathToFileURL(`${directory}${sep}`));
    assert.equal(changedFixtures.rates[0].rate_cents, 6000);
    const updatedSession = randomUUID();
    const before = await newWorkspace(pool, updatedSession, changedFixtures);
    assert.equal(before.project.approvedCents, 970_000);
    const pending = await submitCard(pool, updatedSession, before.workspaceId, changedFixtures, { workDate, hours: 8, requestId: randomUUID() });
    assert.equal(pending.project.pendingCents, 40_000);

    const effectiveDate = before.timecards[0].workDate;
    await pool.query('INSERT INTO labour_rates (project_id, worker_id, effective_from, rate_cents) VALUES ($1, $2, $3, 6000)',
      [fixtures.project.id, fixtures.worker.id, effectiveDate]);
    subtest.after(() => pool.query('DELETE FROM labour_rates WHERE project_id = $1 AND worker_id = $2 AND effective_from = $3',
      [fixtures.project.id, fixtures.worker.id, effectiveDate]).then(() => undefined));
    const after = await newWorkspace(pool, randomUUID(), changedFixtures);
    const expected = after.timecards.reduce((total, card) => {
      const rate = card.workDate >= effectiveDate ? 6000 : 5000;
      assert.equal(card.rateCents, rate);
      return total + rate * card.hours;
    }, 0);
    assert.equal(after.project.approvedCents, expected);
    assert.equal((await readWorkspace(pool, updatedSession, changedFixtures))?.project.approvedCents, 970_000);
  });

  await context.test('preserves approved history after a rate change and resets one browser', async () => {
    await pool.query('INSERT INTO labour_rates (project_id, worker_id, effective_from, rate_cents) VALUES ($1, $2, $3, 6000)',
      [fixtures.project.id, fixtures.worker.id, workDate]);
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

  await context.test('serves only matching previous-release assets after checking current assets', async (subtest) => {
    const directory = await mkdtemp(join(tmpdir(), 'fieldledger-test-assets-'));
    const dist = join(directory, 'dist');
    const current = join(dist, 'assets');
    const previous = join(directory, 'previous');
    await mkdir(current, { recursive: true });
    await mkdir(previous);
    const files = [
      [join(current, 'index-abc12345.js'), 'current script'],
      [join(previous, 'index-abc12345.js'), 'previous script with the same name'],
      [join(previous, 'index-old12345.css'), 'previous stylesheet'],
      [join(previous, 'draft.css'), 'non-hashed file'],
    ];
    await Promise.all(files.map(([file, contents]) => writeFile(file, contents)));
    const assetServer = createApp(pool, fixtures, { staticDirectory: dist, previousAssetsDirectory: previous }).listen(0, '127.0.0.1');
    await once(assetServer, 'listening');
    subtest.after(async () => {
      await new Promise<void>((resolve, reject) => assetServer.close((error) => error ? reject(error) : resolve()));
      await Promise.all(files.map(([file]) => unlink(file)));
      for (const folder of [current, dist, previous, directory]) await rmdir(folder);
    });
    const origin = `http://127.0.0.1:${(assetServer.address() as AddressInfo).port}`;
    assert.equal(await (await fetch(`${origin}/assets/index-abc12345.js`)).text(), 'current script');
    const fallback = await fetch(`${origin}/assets/index-old12345.css`);
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get('Cache-Control') ?? '', /immutable/);
    assert.equal(await fallback.text(), 'previous stylesheet');
    assert.equal((await fetch(`${origin}/assets/draft.css`)).status, 404);
    assert.equal((await fetch(`${origin}/assets/index-missing0.css`)).status, 404);
  });
});

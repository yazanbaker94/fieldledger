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
      body?: unknown; role?: string; origin?: string; cookie?: string; workspace?: string | null; fetchSite?: string; idempotencyKey?: string; openWorkspace?: boolean;
    }) => {
      const headers = new Headers();
      const sentCookie = options?.cookie ?? cookie;
      const sentWorkspace = options?.workspace === null ? '' : options?.workspace ?? workspaceId;
      if (sentCookie) headers.set('Cookie', sentCookie);
      if (sentWorkspace) headers.set('X-Demo-Workspace', sentWorkspace);
      if (endpoint === '/workspace' && (options?.openWorkspace ?? (!sentCookie && !sentWorkspace))) headers.set('X-Demo-Open', '1');
      if (options?.body !== undefined) headers.set('Content-Type', 'application/json');
      if (options?.role) headers.set('X-Demo-Role', options.role);
      if (options?.origin) headers.set('Origin', options.origin);
      if (options?.fetchSite) headers.set('Sec-Fetch-Site', options.fetchSite);
      if (options?.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
      const response = await fetch(`${base}${endpoint}`, { method: options?.body !== undefined ? 'POST' : 'GET', headers, body: JSON.stringify(options?.body) });
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie?.startsWith('__Host-fieldledger-retired-')) {
        assert.equal(endpoint, '/reset');
        assert.ok(setCookie.startsWith(`__Host-fieldledger-retired-${sentWorkspace}=1;`));
        assert.match(setCookie, /; Secure(?:;|$)/i);
        assert.match(setCookie, /; Path=\/(?:;|$)/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.match(setCookie, /; Max-Age=120(?:;|$)/i);
        assert.doesNotMatch(setCookie, /HttpOnly/i);
      } else if (setCookie) {
        assert.match(setCookie, /^__Host-fieldledger=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /; Secure(?:;|$)/i);
        assert.match(setCookie, /; Path=\/(?:;|$)/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.match(setCookie, /; Expires=[^;]+(?:;|$)/i);
        assert.doesNotMatch(setCookie, /; Max-Age=/i);
        cookie = setCookie.split(';')[0];
      }
      const data = await response.json();
      if (response.ok && data.workspaceId) workspaceId = data.workspaceId;
      return { status: response.status, data: data as Workspace, code: data.code as string | undefined,
        sentCookie, sentWorkspace, setCookie, retryAfter: response.headers.get('Retry-After') };
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
    assert.deepEqual(original.data.worker, { id: 'maya', name: 'Maya Chen' });
    assert.deepEqual([...new Set(original.data.timecards.map((card) => card.workerName))].sort(), [
      'Imani Brooks', 'Joel Santos', 'Maya Chen', 'Nadia Haddad',
    ]);
    let approvedCents = 0;
    for (const card of [...original.data.timecards].reverse()) {
      assert.equal(card.approvedBeforeCents, approvedCents);
      assert.equal(card.status, 'approved');
      assert.equal(card.audit[0].actor, card.workerName);
      assert.equal(card.audit[0].workDate, card.workDate);
      assert.equal(card.audit[0].hours, card.hours);
      assert.ok(card.costCents !== null);
      approvedCents += card.costCents;
    }
    assert.equal(approvedCents, original.data.project.approvedCents);
    assert.equal(original.data.timecards.at(-1)?.costCents, 10_000);
    assert.ok(new Set(original.data.timecards.map((card) => card.rateCents)).size > 1);
    const teammate = original.data.timecards.find((card) => card.workerId !== original.data.worker.id);
    assert.ok(teammate);
    assert.equal((await first(`/timecards/${teammate.id}/resubmit`, {
      role: 'worker', body: { workDate: teammate.workDate, hours: teammate.hours, version: teammate.version },
    })).status, 403);
    assert.equal(other.data.project.approvedCents, 970_000);
    assert.notEqual(original.data.workspaceId, other.data.workspaceId);
    assert.notEqual(original.data.workspaceId, original.setCookie?.split(';')[0].split('=')[1]);
    assert.notEqual(original.data.timecards[0].id, other.data.timecards[0].id);
    assert.deepEqual((await first('/workspace')).data, original.data);
  });

  await context.test('streams committed workspace changes only to the matching session', async (subtest) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    subtest.after(() => controller.abort());
    const url = `${base}/workspace/events`;
    const active = browser();
    const separate = browser();
    const [original, other] = await Promise.all([active('/workspace'), separate('/workspace')]);
    const activeCookie = original.setCookie!.split(';')[0];
    const otherCookie = other.setCookie!.split(';')[0];
    assert.equal((await fetch(url)).status, 409);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 405);
    assert.equal((await fetch(url, { headers: { Cookie: activeCookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

    async function connect(cookie: string) {
      const response = await fetch(url, { headers: { Cookie: cookie }, signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type') ?? '', /^text\/event-stream/);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      return async () => {
        while (!buffer.includes('\n\n')) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += value;
        }
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        assert.ok(frame.startsWith('event: change\ndata: '));
        return JSON.parse(frame.slice('event: change\ndata: '.length));
      };
    }

    const [change, separateChange] = await Promise.all([connect(activeCookie), connect(otherCookie)]);
    assert.deepEqual(await change(), { workspaceId: original.data.workspaceId });
    assert.deepEqual(await separateChange(), { workspaceId: other.data.workspaceId });
    const created = await active('/timecards', { role: 'worker', body: submit });
    assert.equal(created.status, 200);
    assert.deepEqual(await change(), { workspaceId: original.data.workspaceId });
    const approved = await active(`/timecards/${created.data.affectedCardId}/decision`, {
      role: 'foreman', body: { decision: 'approve', version: 1 },
    });
    assert.equal(approved.data.project.approvedCents, 1_010_000);
    assert.deepEqual(await change(), { workspaceId: original.data.workspaceId });
    const reset = await active('/reset', { body: {} });
    assert.equal(reset.status, 200);
    assert.deepEqual(await change(), { workspaceId: reset.data.workspaceId, retiredWorkspaceId: original.data.workspaceId });

    // A reset for the separate session must be the first event it sees after connecting.
    const otherReset = await separate('/reset', { body: {} });
    assert.equal(otherReset.status, 200);
    assert.deepEqual(await separateChange(), { workspaceId: otherReset.data.workspaceId, retiredWorkspaceId: other.data.workspaceId });
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
    const cardId = saved.data.affectedCardId;
    assert.ok(cardId);
    assert.equal((await client(`/timecards/${cardId}/decision`, {
      role: 'foreman', body: { decision: 'return', reason: 'Correct the duration', version: 1 },
    })).status, 200);
    const reuse = await client(`/timecards/${cardId}/resubmit`, {
      ...worker, body: { ...draft, version: 2 },
    });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.code, 'submission_discarded');
    assert.equal((await client(receipt)).status, 410);
    assert.equal((await client('/workspace')).data.timecards.find((card) => card.id === cardId)?.status, 'returned');

    const sessionId = before.setCookie?.split(';')[0].split('=')[1];
    assert.ok(sessionId);
    const blocked = { code: '23514', constraint: 'timecard_request_not_discarded' };
    // Older releases can write directly without consulting the discard table.
    await assert.rejects(pool.query(`INSERT INTO timecards (session_id, project_id, worker_id, work_date, hours, status, request_id, request_digest)
      VALUES ($1, $2, $3, $4, 8, 'pending', $5, 'legacy')`,
    [sessionId, fixtures.project.id, fixtures.worker.id, workDate, draft.requestId]), blocked);
    await assert.rejects(pool.query(`INSERT INTO timecard_correction_receipts (session_id, workspace_id, request_id, timecard_id, request_digest)
      VALUES ($1, $2, $3, $4, 'legacy')`, [sessionId, before.data.workspaceId, draft.requestId, cardId]), blocked);

    assert.equal((await client('/reset', { body: {} })).status, 200);
    assert.equal((await client(receipt)).status, 404);
    assert.equal((await client('/timecards', { ...worker, workspace: before.data.workspaceId, body: draft })).code, 'workspace_changed');
    assert.equal((await client('/timecards', { ...worker, body: draft })).status, 200);
  });

  await context.test('returns, corrects and approves once, preserving the audit trail', async () => {
    const endpoint = `/timecards/${id}/decision`;
    assert.equal((await first(endpoint, { role: 'worker', body: { decision: 'approve', version: 1 } })).status, 403);
    assert.equal((await first(endpoint, { role: 'manager', body: { decision: 'approve', version: 1 } })).status, 403);
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
    assert.equal(card.approvedBeforeCents, 970_000);
    assert.equal(duplicate.data.timecards.find((candidate) => candidate.id === id)?.approvedBeforeCents, 970_000);
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
    const firstReturn = { role: 'foreman', body: { decision: 'return', version: 1, reason: 'Correct the date and duration' } };
    assert.equal((await client(decision, firstReturn)).status, 200);
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
    const confirmedReturn = await client(decision, firstReturn);
    assert.equal(confirmedReturn.status, 200);
    assert.deepEqual(confirmedReturn.data, corrected.data);
    const secondReturn = { role: 'foreman', body: { decision: 'return', version: 3, reason: 'Use the original date' } };
    assert.equal((await client(decision, secondReturn)).status, 200);
    const secondCorrection = { role: 'worker', body: { workDate, hours: 7, version: 4, requestId: randomUUID() } };
    assert.equal((await client(resubmit, secondCorrection)).status, 200);
    assert.equal((await client(decision, { role: 'foreman', body: { decision: 'approve', version: 5 } })).status, 200);
    const replay = await client(resubmit.toUpperCase(), firstCorrection);
    const reconciled = await client(`/timecards/submissions/${correctionId}`);
    assert.equal(replay.data.affectedCardId, cardId);
    assert.deepEqual(reconciled.data, replay.data);
    for (const action of [firstReturn, secondReturn]) {
      const replayedReturn = await client(decision, action);
      assert.equal(replayedReturn.status, 200);
      assert.deepEqual(replayedReturn.data, replay.data);
    }
    assert.equal((await client(decision, { ...firstReturn, body: { ...firstReturn.body, reason: secondReturn.body.reason } })).status, 409);
    assert.equal((await client(decision, { ...firstReturn, body: { ...firstReturn.body, version: 2 } })).status, 409);
    assert.equal((await client(decision, { role: 'foreman', body: { decision: 'approve', version: 1 } })).status, 409);
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
    const { session: updatedSession, workspace: before } = await newWorkspace(pool, changedFixtures);
    assert.equal(before.project.approvedCents, 970_000);
    const pending = await submitCard(pool, updatedSession, before.workspaceId, changedFixtures, { workDate, hours: 8, requestId: randomUUID() });
    assert.equal(pending.project.pendingCents, 40_000);

    const effectiveDate = before.timecards[0].workDate;
    await pool.query('INSERT INTO labour_rates (project_id, worker_id, effective_from, rate_cents) VALUES ($1, $2, $3, 6000)',
      [fixtures.project.id, fixtures.worker.id, effectiveDate]);
    subtest.after(() => pool.query('DELETE FROM labour_rates WHERE project_id = $1 AND worker_id = $2 AND effective_from = $3',
      [fixtures.project.id, fixtures.worker.id, effectiveDate]).then(() => undefined));
    const { workspace: after } = await newWorkspace(pool, changedFixtures);
    const originalByShift = new Map(before.timecards.map((card) => [`${card.workerId}:${card.workDate}`, card]));
    const expected = after.timecards.reduce((total, card) => {
      const original = originalByShift.get(`${card.workerId}:${card.workDate}`);
      assert.ok(original && original.rateCents !== null);
      const rate = card.workerId === before.worker.id && card.workDate >= effectiveDate ? 6000 : original.rateCents;
      assert.equal(card.rateCents, rate);
      return total + Math.round(rate * card.hours);
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
    assert.ok(reset.setCookie?.startsWith(`__Host-fieldledger-retired-${reset.sentWorkspace}=1;`));
    assert.notEqual(reset.data.workspaceId, reset.sentWorkspace);
    assert.equal(reset.data.project.approvedCents, 970_000);
    assert.equal(reset.data.project.pendingCents, 0);
    assert.ok(!reset.data.timecards.some((card) => card.id === id));
    const oldWrite = await first('/timecards', { role: 'worker', cookie: reset.sentCookie, workspace: reset.sentWorkspace, body: submit });
    assert.equal(oldWrite.status, 409);
    assert.equal(oldWrite.code, 'workspace_changed');
    const staleRead = await first('/workspace', { cookie: reset.sentCookie, workspace: reset.sentWorkspace });
    assert.equal(staleRead.status, 200);
    assert.equal(staleRead.setCookie, null);
    assert.equal(staleRead.data.workspaceId, reset.data.workspaceId);
    assert.equal((await first('/reset', { body: {} })).status, 429);
    assert.deepEqual((await second('/workspace')).data, beforeReset.data);
  });

  await context.test('uses the stored expiry and leaves an active session cookie unchanged', async () => {
    const client = browser();
    const original = await client('/workspace');
    assert.equal(original.status, 200);
    const session = original.setCookie?.split(';')[0].split('=')[1];
    const cookieExpiry = original.setCookie?.match(/; Expires=([^;]+)/i)?.[1];
    assert.ok(session);
    assert.ok(cookieExpiry);
    const { rows: [row] } = await pool.query<{ expires_at: Date }>('SELECT expires_at FROM demo_sessions WHERE id = $1', [session]);
    assert.equal(cookieExpiry, row.expires_at.toUTCString());
    const reopened = await client('/workspace', { workspace: null });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.setCookie, null);
    assert.equal(reopened.data.workspaceId, original.data.workspaceId);
  });

  await context.test('waits for an expired cookie to go away before opening another writable workspace', async () => {
    const client = browser();
    const original = await client('/workspace');
    const oldCookie = original.setCookie?.split(';')[0];
    assert.ok(oldCookie);
    const session = oldCookie.split('=')[1];
    await pool.query(`UPDATE demo_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [session]);
    const stopped = await client('/timecards', { role: 'worker', body: submit });
    assert.equal(stopped.status, 409);
    assert.equal(stopped.code, 'workspace_expired');
    const staleRequests = await Promise.all([client('/workspace'), client('/workspace')]);
    for (const response of staleRequests) {
      assert.equal(response.status, 429);
      assert.equal(response.code, 'workspace_expired');
      assert.equal(response.retryAfter, '1');
      assert.equal(response.setCookie, null);
    }
    const { rows } = await pool.query(`
      SELECT workspace_id, expires_at <= now() AS expired FROM demo_sessions WHERE id = $1
    `, [session]);
    assert.deepEqual(rows, [{ workspace_id: original.data.workspaceId, expired: true }]);

    const before = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM demo_sessions');
    const legacyWithoutCookie = await client('/workspace', { cookie: '', workspace: null, openWorkspace: false });
    assert.equal(legacyWithoutCookie.status, 429);
    assert.equal(legacyWithoutCookie.code, 'workspace_expired');
    assert.equal(legacyWithoutCookie.retryAfter, '1');
    assert.equal(legacyWithoutCookie.setCookie, null);
    const readWithoutCookie = await client('/workspace', { cookie: '' });
    assert.equal(readWithoutCookie.status, 409);
    assert.equal(readWithoutCookie.code, 'workspace_expired');
    assert.equal(readWithoutCookie.setCookie, null);
    const after = await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM demo_sessions');
    assert.equal(after.rows[0].count, before.rows[0].count);

    const fresh = await client('/workspace', { cookie: '', workspace: null });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.data.workspaceId, original.data.workspaceId);
    assert.ok(fresh.setCookie);
    const saved = await client('/timecards', { role: 'worker', body: submit });
    assert.equal(saved.status, 200);
    assert.ok(saved.data.affectedCardId);

    // A request already carrying the old token must never send a cookie that could replace the fresh one.
    const late = await client('/workspace', { cookie: oldCookie, workspace: original.data.workspaceId });
    assert.equal(late.status, 429);
    assert.equal(late.setCookie, null);
    const current = await client('/workspace');
    assert.equal(current.data.workspaceId, fresh.data.workspaceId);
    assert.ok(current.data.timecards.some((card) => card.id === saved.data.affectedCardId));
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
    const directory = await mkdtemp(join(tmpdir(), '.fieldledger-test-assets-'));
    const dist = join(directory, 'dist');
    const current = join(dist, 'assets');
    const previous = join(directory, 'previous');
    await mkdir(current, { recursive: true });
    await mkdir(previous);
    const files = [
      [join(dist, 'index.html'), '<!doctype html><title>FieldLedger</title>'],
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
    const html = await fetch(origin, { headers: { Accept: 'text/html' } });
    assert.equal(html.status, 200);
    assert.equal(await html.text(), '<!doctype html><title>FieldLedger</title>');
    assert.equal(await (await fetch(`${origin}/assets/index-abc12345.js`)).text(), 'current script');
    const fallback = await fetch(`${origin}/assets/index-old12345.css`);
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get('Cache-Control') ?? '', /immutable/);
    assert.equal(await fallback.text(), 'previous stylesheet');
    assert.equal((await fetch(`${origin}/assets/draft.css`)).status, 404);
    assert.equal((await fetch(`${origin}/assets/index-missing0.css`)).status, 404);
  });
});

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Fixtures } from './db.js';
import {
  ApiError, cardId, decisionInput, decideCard, discardSubmission, newWorkspace, readWorkspace, reconcileSubmission, resetWorkspace,
  resubmitCard, resubmitInput, submitCard, submitInput,
} from './workspace.js';

interface Options {
  origin?: string;
  secureCookies?: boolean;
  staticDirectory?: string;
  previousAssetsDirectory?: string;
  trustProxy?: number;
  newSessionsPerHour?: number;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue.path[0] === 'hours' ? 'Enter between 0.01 and 24 hours, with at most two decimal places.'
      : issue.path[0] === 'workDate' ? 'Choose a valid work date on or before today.'
      : issue.path[0] === 'reason' ? 'Enter a return reason of 1 to 500 valid characters.' : 'Check the request and try again.';
    throw new ApiError(400, message);
  }
  return parsed.data;
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie?.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  const parsed = z.uuidv4().safeParse(raw?.slice(name.length + 1));
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

function requireRole(req: Request, role: 'worker' | 'foreman') {
  // Role selection is an intentional feature of the fictional public demo.
  if (req.get('X-Demo-Role') !== role) throw new ApiError(403, `Switch to the ${role} view for this action.`);
}

function requireSameSite(req: Request) {
  if (req.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'This request must come from the demo app.');
}

function requireWorkspace(req: Request): string {
  const parsed = z.uuidv4().safeParse(req.get('X-Demo-Workspace'));
  if (!parsed.success) throw new ApiError(409, 'Reload the page to use the current demo workspace.', 'workspace_required');
  return parsed.data.toLowerCase();
}

function newSessionLimiter(maxAttempts = 30) {
  const buckets = new Map<string, { attempts: number; expires: number }>();
  let nextCleanup = 0;
  let earliestExpiry = Number.POSITIVE_INFINITY;
  return (ip: string) => {
    const now = Date.now();
    const secondsUntil = (expires: number) => Math.max(1, Math.ceil((expires - now) / 1000));
    if (nextCleanup <= now) {
      earliestExpiry = Number.POSITIVE_INFINITY;
      for (const [key, bucket] of buckets) {
        if (bucket.expires <= now) buckets.delete(key);
        else earliestExpiry = Math.min(earliestExpiry, bucket.expires);
      }
      nextCleanup = now + 60_000;
    }
    const previous = buckets.get(ip);
    if (!previous && buckets.size >= 4096) return secondsUntil(Math.max(earliestExpiry, nextCleanup));
    const bucket = previous && previous.expires > now ? previous : { attempts: 0, expires: now + 3_600_000 };
    if (bucket.attempts >= maxAttempts) return secondsUntil(bucket.expires);
    bucket.attempts += 1;
    buckets.set(ip, bucket);
    earliestExpiry = Math.min(earliestExpiry, bucket.expires);
  };
}

export function createApp(pool: Pool, fixtures: Fixtures, options: Options = {}) {
  const app = express();
  const cookieName = options.secureCookies ? '__Host-fieldledger' : 'fieldledger';
  const limitSession = newSessionLimiter(options.newSessionsPerHour);
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    if (options.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (options.staticDirectory) {
      res.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    }
    next();
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      requireSameSite(req);
      const origin = req.get('Origin');
      if (options.origin && origin && origin !== options.origin) {
        throw new ApiError(403, 'This request must come from the demo app.');
      }
      if (!req.is('application/json')) throw new ApiError(415, 'Send an application/json request.');
    }
    next();
  });
  api.use(express.json({ limit: '8kb' }));

  function requireSession(req: Request) {
    const session = readCookie(req, cookieName);
    if (!session) throw new ApiError(409, 'Start or reload the demo before changing a timecard.', 'workspace_expired');
    return session;
  }

  function setSessionCookie(res: Response, session: string) {
    res.cookie(cookieName, session, { httpOnly: true, sameSite: 'lax', secure: options.secureCookies, path: '/', maxAge: 86_400_000 });
  }

  api.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  api.head('/workspace', (_req, res) => res.set('Allow', 'GET').sendStatus(405));
  api.get('/workspace', async (req, res) => {
    requireSameSite(req);
    const existing = readCookie(req, cookieName);
    if (existing) {
      const workspace = await readWorkspace(pool, existing, fixtures);
      if (workspace) {
        res.json(workspace);
        return;
      }
    }
    const retryAfter = limitSession(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    if (retryAfter !== undefined) {
      res.set('Retry-After', String(retryAfter));
      throw new ApiError(429, 'Too many new demo sessions. Try again later.');
    }
    // Never reissue a cookie for an existing browser token, even when its workspace expired.
    const session = existing ?? randomUUID();
    const workspace = await newWorkspace(pool, session, fixtures);
    if (!existing) setSessionCookie(res, session);
    res.json(workspace);
  });

  api.get('/timecards/submissions/:requestId', async (req, res) => {
    requireSameSite(req);
    const workspace = await reconcileSubmission(pool, requireSession(req), requireWorkspace(req), fixtures, validate(cardId, req.params.requestId));
    res.json(workspace);
  });

  api.post('/timecards/submissions/:requestId/discard', async (req, res) => {
    requireRole(req, 'worker');
    const workspace = await discardSubmission(pool, requireSession(req), requireWorkspace(req), fixtures, validate(cardId, req.params.requestId));
    res.json(workspace);
  });

  api.post('/timecards', async (req, res) => {
    requireRole(req, 'worker');
    const workspace = await submitCard(pool, requireSession(req), requireWorkspace(req), fixtures, validate(submitInput, req.body));
    res.json(workspace);
  });

  api.post('/timecards/:id/resubmit', async (req, res) => {
    requireRole(req, 'worker');
    const key = req.get('Idempotency-Key');
    if (key !== undefined && req.body?.requestId !== undefined && req.body.requestId !== key) {
      throw new ApiError(400, 'The correction request IDs must match.');
    }
    const body = key === undefined ? req.body : { ...req.body, requestId: key };
    const workspace = await resubmitCard(pool, requireSession(req), requireWorkspace(req), fixtures, validate(cardId, req.params.id), validate(resubmitInput, body));
    res.json(workspace);
  });

  api.post('/timecards/:id/decision', async (req, res) => {
    requireRole(req, 'foreman');
    const workspace = await decideCard(pool, requireSession(req), requireWorkspace(req), fixtures, validate(cardId, req.params.id), validate(decisionInput, req.body));
    res.json(workspace);
  });

  api.post('/reset', async (req, res) => {
    const session = requireSession(req);
    const retiringId = requireWorkspace(req);
    const workspace = await resetWorkspace(pool, session, retiringId, fixtures);
    // Set a browser-wide fence even when an older open bundle made the request.
    const marker = `${options.secureCookies ? '__Host-' : ''}fieldledger-retired-${retiringId}`;
    res.cookie(marker, '1', { sameSite: 'lax', secure: options.secureCookies, path: '/', maxAge: 120_000 });
    res.json(workspace);
  });

  api.use((_req, res) => res.status(404).json({ message: 'This endpoint was not found.' }));
  app.use('/api', api);

  if (options.staticDirectory) {
    const directory = options.staticDirectory;
    const immutable = { index: false, immutable: true, maxAge: '1y' } as const;
    app.use('/assets', express.static(path.join(directory, 'assets'), immutable));
    if (options.previousAssetsDirectory) {
      const servePreviousAsset = express.static(options.previousAssetsDirectory, immutable);
      app.use('/assets', (req, res, next) => {
        // Vite's default output uses an eight-character hash. Only serve hashed filenames from the previous release.
        if (!/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*-[a-zA-Z0-9_-]{8}\.[a-zA-Z0-9]+$/.test(req.path)) return next();
        return servePreviousAsset(req, res, next);
      });
    }
    app.use(express.static(directory, { index: false }));
    app.get('/{*path}', (req, res, next) => {
      if (path.extname(req.path) || !req.accepts('html')) {
        next();
        return;
      }
      res.set('Cache-Control', 'no-cache').sendFile(path.join(directory, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ApiError) {
      res.status(error.status).json({ message: error.message, ...(error.code && { code: error.code }) });
      return;
    }
    if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
      res.status(400).json({ message: 'The request body is invalid.' });
      return;
    }
    if (error && typeof error === 'object' && 'status' in error && (error.status === 404 || error.status === 413 || error.status === 415)) {
      res.status(error.status).json({ message: error.status === 404 ? 'The requested resource was not found.' : 'The request body is unsupported or too large.' });
      return;
    }
    console.error('Unhandled application error', error);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  });
  return app;
}

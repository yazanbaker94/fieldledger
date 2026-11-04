import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Fixtures } from './db.js';
import {
  ApiError, cardId, decisionInput, decideCard, newWorkspace, readWorkspace, resetWorkspace,
  resubmitCard, resubmitInput, submitCard, submitInput,
} from './workspace.js';

interface Options {
  origin?: string;
  secureCookies?: boolean;
  staticDirectory?: string;
  trustProxy?: number;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue.path[0] === 'hours' ? 'Enter between 0.01 and 24 hours, with at most two decimal places.'
      : issue.path[0] === 'workDate' ? 'Choose a valid work date on or before today.'
      : issue.path[0] === 'reason' ? 'Enter a return reason of 1 to 500 characters.' : 'Check the request and try again.';
    throw new ApiError(400, message);
  }
  return parsed.data;
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie?.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  const parsed = z.uuid().safeParse(raw?.slice(name.length + 1));
  return parsed.success ? parsed.data : undefined;
}

function requireRole(req: Request, role: 'worker' | 'foreman') {
  // Role selection is an intentional feature of the fictional public demo.
  if (req.get('X-Demo-Role') !== role) throw new ApiError(403, `Switch to the ${role} view for this action.`);
}

function newSessionLimiter() {
  const buckets = new Map<string, { attempts: number; expires: number }>();
  let nextCleanup = 0;
  return (ip: string) => {
    const now = Date.now();
    if (nextCleanup < now) {
      for (const [key, bucket] of buckets) if (bucket.expires < now) buckets.delete(key);
      nextCleanup = now + 60_000;
    }
    const previous = buckets.get(ip);
    if (!previous && buckets.size >= 4096) throw new ApiError(429, 'Too many new demo sessions. Try again later.');
    const bucket = previous && previous.expires >= now ? previous : { attempts: 0, expires: now + 3_600_000 };
    if (bucket.attempts >= 30) throw new ApiError(429, 'Too many new demo sessions. Try again later.');
    bucket.attempts += 1;
    buckets.set(ip, bucket);
  };
}

export function createApp(pool: Pool, fixtures: Fixtures, options: Options = {}) {
  const app = express();
  const cookieName = options.secureCookies ? '__Host-fieldledger' : 'fieldledger';
  const limitSession = newSessionLimiter();
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
    if (req.get('Sec-Fetch-Site') === 'cross-site' && (req.method === 'POST' || req.path === '/workspace')) {
      throw new ApiError(403, 'This request must come from the demo app.');
    }
    if (req.method === 'POST') {
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
    if (!session) throw new ApiError(409, 'Start or reload the demo before changing a timecard.');
    return session;
  }

  function setSessionCookie(res: Response, session: string, maxAge = 86_400_000) {
    res.cookie(cookieName, session, { httpOnly: true, sameSite: 'lax', secure: options.secureCookies, path: '/', maxAge });
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
    const existing = readCookie(req, cookieName);
    if (existing) {
      const workspace = await readWorkspace(pool, existing, fixtures);
      if (workspace) {
        res.json(workspace);
        return;
      }
    }
    limitSession(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const session = randomUUID();
    const workspace = await newWorkspace(pool, session, fixtures);
    setSessionCookie(res, session);
    res.json(workspace);
  });

  api.post('/timecards', async (req, res) => {
    requireRole(req, 'worker');
    const workspace = await submitCard(pool, requireSession(req), fixtures, validate(submitInput, req.body));
    res.json(workspace);
  });

  api.post('/timecards/:id/resubmit', async (req, res) => {
    requireRole(req, 'worker');
    const workspace = await resubmitCard(pool, requireSession(req), fixtures, validate(cardId, req.params.id), validate(resubmitInput, req.body));
    res.json(workspace);
  });

  api.post('/timecards/:id/decision', async (req, res) => {
    requireRole(req, 'foreman');
    const workspace = await decideCard(pool, requireSession(req), fixtures, validate(cardId, req.params.id), validate(decisionInput, req.body));
    res.json(workspace);
  });

  api.post('/reset', async (req, res) => {
    const replacement = randomUUID();
    const { workspace, expiresAt } = await resetWorkspace(pool, requireSession(req), replacement, fixtures);
    setSessionCookie(res, replacement, Math.max(0, expiresAt.getTime() - Date.now()));
    res.json(workspace);
  });

  api.use((_req, res) => res.status(404).json({ message: 'This endpoint was not found.' }));
  app.use('/api', api);

  if (options.staticDirectory) {
    const directory = options.staticDirectory;
    app.use('/assets', express.static(path.join(directory, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
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
      res.status(error.status).json({ message: error.message });
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

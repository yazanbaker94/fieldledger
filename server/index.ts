import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { prepareDatabase } from './db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL before starting Field Ledger.');

const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

const originUrl = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN) : undefined;
if (originUrl && originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') throw new Error('APP_ORIGIN must use HTTP or HTTPS.');
const origin = originUrl?.origin;
const trustProxy = Number(process.env.TRUST_PROXY ?? '0');
if (!Number.isInteger(trustProxy) || trustProxy < 0) throw new Error('TRUST_PROXY must be a nonnegative proxy hop count.');

const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
pool.on('error', (error) => console.error('Idle database connection error', error.message));

try {
  const fixtures = await prepareDatabase(pool);
  const previousAssetsDirectory = process.env.PREVIOUS_ASSETS_DIRECTORY
    ? await realpath(process.env.PREVIOUS_ASSETS_DIRECTORY).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    })
    : undefined;
  const app = createApp(pool, fixtures, {
    origin,
    secureCookies: origin?.startsWith('https://') ?? false,
    staticDirectory: fileURLToPath(new URL('../dist/', import.meta.url)),
    previousAssetsDirectory,
    trustProxy,
  });
  const cleanup = setInterval(() => {
    void pool.query('DELETE FROM demo_sessions WHERE expires_at <= now()').catch((error) => console.error('Demo cleanup error', error.message));
  }, 15 * 60_000);
  cleanup.unref();

  const server = app.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Field Ledger listening on port ${port}`));
  const shutdown = () => {
    clearInterval(cleanup);
    server.close(() => void pool.end());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  await pool.end();
  throw error;
}

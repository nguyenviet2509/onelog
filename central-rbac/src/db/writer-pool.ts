/**
 * writer-pool.ts — pg.Pool for rbac_writer role.
 * Used for all mutations: INSERT/UPDATE/DELETE on rbac.* tables,
 * and INSERT-only on audit_log.
 */
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export const writerPool = new pg.Pool({
  connectionString: config.WRITER_DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

writerPool.on('error', (err) => {
  logger.error({ err }, 'writer-pool: unexpected idle client error');
});

export async function checkWriterConnection(): Promise<boolean> {
  try {
    const client = await writerPool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (err) {
    logger.error({ err }, 'writer-pool: connection check failed');
    return false;
  }
}

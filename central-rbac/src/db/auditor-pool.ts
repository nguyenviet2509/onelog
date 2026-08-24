/**
 * auditor-pool.ts — pg.Pool for rbac_auditor role.
 * SELECT-only on audit_log. Enforced at DB layer, not just app trust.
 */
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export const auditorPool = new pg.Pool({
  connectionString: config.AUDITOR_DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

auditorPool.on('error', (err) => {
  logger.error({ err }, 'auditor-pool: unexpected idle client error');
});

export async function checkAuditorConnection(): Promise<boolean> {
  try {
    const client = await auditorPool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (err) {
    logger.error({ err }, 'auditor-pool: connection check failed');
    return false;
  }
}

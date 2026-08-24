/**
 * scripts/migrate.ts — Idempotent migration runner.
 * Runs migrations 002-004 in order against central_rbac DB (writer conn).
 * Migration 001 is external (run by ops as postgres superuser).
 * Tracks applied versions in rbac.schema_migrations.
 *
 * Usage: npm run migrate
 *        DATABASE_URL=<url> tsx scripts/migrate.ts
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Migrations to run (001 is external)
const MIGRATIONS = [
  { version: 2, file: '002_rbac_tables.sql' },
  { version: 3, file: '003_audit_hash_chain.sql' },
  { version: 4, file: '004_audit_immutable_trigger.sql' },
];

async function migrate() {
  const connectionString =
    process.env['WRITER_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://rbac_writer:rbac_writer_changeme@localhost:5433/central_rbac';

  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    console.log('Running migrations against:', connectionString.replace(/:[^:@]+@/, ':***@'));

    // Ensure schema_migrations table exists (bootstrapped by 002, but handle cold start)
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS rbac;
      CREATE TABLE IF NOT EXISTS rbac.schema_migrations (
        version     INTEGER     PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        description TEXT        NOT NULL DEFAULT ''
      );
    `);

    // Load applied versions
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM rbac.schema_migrations ORDER BY version',
    );
    const appliedVersions = new Set(applied.rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        console.log(`  [skip] migration ${migration.version} already applied`);
        continue;
      }

      const sqlPath = join(__dirname, '../src/db/migrations', migration.file);
      const sql = await readFile(sqlPath, 'utf8');

      console.log(`  [run ] migration ${migration.version}: ${migration.file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
        console.log(`  [ok  ] migration ${migration.version} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.version} failed: ${err}`);
      }
    }

    console.log('All migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

/**
 * Lazy singleton Postgres client + Drizzle handle.
 *
 * Lazy so module imports (e.g. during `next build`) don't try to connect.
 * Same pattern Next.js docs recommend for app-router server routes.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

let _sql: postgres.Sql | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  _sql = postgres(url, { max: 5, idle_timeout: 30 });
  _db = drizzle(_sql, { schema });
  return _db;
}

export { schema };

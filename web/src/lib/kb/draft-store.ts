/**
 * KB draft store — CRUD for kb_drafts table.
 *
 * Drafts are short-lived (TTL = KB_DRAFT_TTL_MINUTES, default 30 min).
 * auth: access_token (32-byte hex) stored in draft row + passed in review URL.
 *
 * Flow:
 *   summarize API → createDraft() → returns {draftId, accessToken}
 *   review page → getDraftByToken() → verifies token + expiry → returns DraftEntry
 *   entries API → getDraftByToken() then deleteDraft() after commit
 */

import { randomBytes, timingSafeEqual } from "crypto";
import { eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { DraftEntry } from "./summarizer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DraftRecord {
  id: string;
  openwebuiChatId: string;
  openwebuiUserId: string;
  draft: DraftEntry;
  accessToken: string;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ttlMinutes(): number {
  return parseInt(process.env.KB_DRAFT_TTL_MINUTES ?? "30", 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new draft record and persist to Postgres.
 * Returns the generated draft id and access_token for inclusion in review URL.
 */
export async function createDraft(
  openwebuiChatId: string,
  openwebuiUserId: string,
  draft: DraftEntry,
): Promise<{ draftId: string; accessToken: string }> {
  const db = getDb();
  const accessToken = randomBytes(32).toString("hex");
  const ttl = ttlMinutes();
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  const [row] = await db
    .insert(schema.kbDrafts)
    .values({
      openwebuiChatId,
      openwebuiUserId,
      draftJson: draft as unknown as Record<string, unknown>,
      accessToken,
      expiresAt,
    })
    .returning({ id: schema.kbDrafts.id });

  return { draftId: row.id, accessToken };
}

/**
 * Retrieve a draft by id + access_token, checking expiry.
 * Returns null if not found, expired, or token mismatch.
 * Does NOT check user_id — access_token is the auth mechanism for review page.
 */
export async function getDraftByToken(
  draftId: string,
  accessToken: string,
): Promise<DraftRecord | null> {
  const db = getDb();

  const [row] = await db
    .select()
    .from(schema.kbDrafts)
    .where(eq(schema.kbDrafts.id, draftId))
    .limit(1);

  if (!row) return null;

  // Timing-safe compare — prevents token enumeration via timing side-channel.
  // Guard length first: timingSafeEqual throws on length mismatch.
  try {
    const a = Buffer.from(row.accessToken, "hex");
    const b = Buffer.from(accessToken, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    // Buffer.from() can throw on non-hex input — treat as mismatch
    return null;
  }

  if (row.expiresAt < new Date()) return null;

  return {
    id: row.id,
    openwebuiChatId: row.openwebuiChatId,
    openwebuiUserId: row.openwebuiUserId,
    draft: row.draftJson as unknown as DraftEntry,
    accessToken: row.accessToken,
    expiresAt: row.expiresAt,
  };
}

/**
 * Delete a draft by id. Called after successful entry commit.
 * Best-effort: does not throw if row already gone.
 */
export async function deleteDraft(draftId: string): Promise<void> {
  const db = getDb();
  await db.delete(schema.kbDrafts).where(eq(schema.kbDrafts.id, draftId));
}

/**
 * Delete all expired drafts. Call from a cron endpoint or cleanup route.
 * Returns the count of deleted rows.
 */
export async function cleanupExpiredDrafts(): Promise<number> {
  const db = getDb();
  const result = await db
    .delete(schema.kbDrafts)
    .where(lt(schema.kbDrafts.expiresAt, new Date()))
    .returning({ id: schema.kbDrafts.id });
  return result.length;
}

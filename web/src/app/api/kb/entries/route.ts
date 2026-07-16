/**
 * POST /api/kb/entries
 *
 * Input:  { entry: EntryPayload, force?: boolean }
 * Output: { id: string } on success
 *         { dedupHits: DedupHit[] } when near-duplicate found and force != true
 *
 * Flow:
 *   1. Validate + redact PII from all text fields
 *   2. Embed (title + symptom + root_cause)
 *   3. Dedup check via Qdrant — return dedupHits if top-1 score > threshold
 *   4. INSERT kb_entries (Postgres) first, then upsert Qdrant point:
 *      - Postgres insert first (benefits from FK/uniqueness constraint enforcement)
 *      - Qdrant upsert second; if Qdrant fails → DELETE Postgres row (rollback)
 *      - Double failure (rollback also fails) → logged as kb.entries.rollback_failed;
 *        reconcile job (Phase 2+) will clean up orphan rows via WHERE embedding_id IS NULL
 *   5. Increment taxonomy usage_count for dept/topic/issue_type
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getCurrentUser } from "@/lib/auth-stub";
import { redact } from "@/lib/kb/redact";
import { embedText } from "@/lib/kb/embed-client";
import { checkDuplicates, type DedupHit } from "@/lib/kb/dedup";
import { upsertPoint, ensureCollection, type QdrantPayload } from "@/lib/kb/qdrant-client";
import { and, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const EntryPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  title: z.string().min(1).max(200),
  symptom: z.string().min(1),
  root_cause: z.string().min(1),
  fix: z.string().min(1),
  department: z.string().max(32).optional(),
  topic: z.string().max(64).optional(),
  issue_type: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(20).default([]),
});

const BodySchema = z.object({
  entry: EntryPayloadSchema,
  force: z.boolean().optional().default(false),
});

export type EntryPayload = z.infer<typeof EntryPayloadSchema>;

export interface EntriesSuccessResponse {
  id: string;
}

export interface EntryDedupResponse {
  dedupHits: DedupHit[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Redact PII from all user-supplied text fields. */
function redactEntry(entry: EntryPayload): EntryPayload {
  return {
    ...entry,
    title: redact(entry.title),
    symptom: redact(entry.symptom),
    root_cause: redact(entry.root_cause),
    fix: redact(entry.fix),
    tags: entry.tags.map(redact),
  };
}

/** Increment taxonomy usage_count atomically. Best-effort — never throws. */
async function bumpTaxonomy(
  kind: string,
  value: string | undefined,
): Promise<void> {
  if (!value) return;
  try {
    const db = getDb();
    await db.execute(
      sql`UPDATE kb_taxonomy SET usage_count = usage_count + 1
          WHERE kind = ${kind} AND value = ${value}`,
    );
  } catch (err) {
    console.warn("kb.entries.bump_taxonomy_failed", { kind, value, err });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  await ensureBootstrap();
  const user = getCurrentUser();
  const db = getDb();

  // --- Parse + validate body ---
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { force } = parsed.data;
  const entry = redactEntry(parsed.data.entry);

  // --- Verify conversation ownership (C3: prevent cross-user attachment) ---
  const [ownedConv] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, entry.conversationId),
        eq(schema.conversations.userId, user.id),
      ),
    )
    .limit(1);

  if (!ownedConv) {
    // Return 403 — do NOT leak whether the conversation exists
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // --- Ensure Qdrant collection exists ---
  try {
    await ensureCollection();
  } catch (err) {
    console.error("kb.entries.qdrant_collection_failed", err);
    return NextResponse.json(
      { error: "Vector store unavailable" },
      { status: 503 },
    );
  }

  // --- Embed (title + symptom + root_cause) ---
  const textToEmbed = [entry.title, entry.symptom, entry.root_cause]
    .filter(Boolean)
    .join(" ");

  let vector: number[];
  try {
    vector = await embedText(textToEmbed);
  } catch (err) {
    console.error("kb.entries.embed_failed", err);
    return NextResponse.json(
      { error: "Embedding failed — cannot create entry" },
      { status: 502 },
    );
  }

  // --- Dedup check (skip when force=true) ---
  if (!force) {
    const hits = await checkDuplicates(vector);
    if (hits.length > 0) {
      return NextResponse.json(
        { dedupHits: hits } satisfies EntryDedupResponse,
        { status: 409 },
      );
    }
  }

  // --- Generate entry UUID for both Postgres + Qdrant point ---
  const [{ id: entryId }] = await db
    .insert(schema.kbEntries)
    .values({
      conversationId: entry.conversationId,
      title: entry.title,
      department: entry.department,
      topic: entry.topic,
      issueType: entry.issue_type,
      tags: entry.tags.length > 0 ? entry.tags : null,
      symptom: entry.symptom,
      rootCause: entry.root_cause,
      fix: entry.fix,
      embeddingId: null, // set after Qdrant upsert below
      createdBy: user.id,
      upvotes: 0,
      verifiedBy: [],
    })
    .returning({ id: schema.kbEntries.id });

  // --- Upsert Qdrant point ---
  const qdrantPayload: QdrantPayload = {
    entryId,
    title: entry.title,
    department: entry.department,
    topic: entry.topic,
    issueType: entry.issue_type,
    conversationId: entry.conversationId,
    createdAt: new Date().toISOString(),
  };

  try {
    await upsertPoint(entryId, vector, qdrantPayload);
  } catch (qdrantErr) {
    // Rollback: delete the Postgres row so state stays consistent
    console.error("kb.entries.qdrant_upsert_failed_rollback", { entry_id: entryId, err: qdrantErr });
    try {
      await db
        .delete(schema.kbEntries)
        .where(eq(schema.kbEntries.id, entryId));
    } catch (rollbackErr) {
      // Orphan row with embedding_id=null remains; reconcile job (Phase 2+) will
      // sweep via WHERE embedding_id IS NULL to detect and clean up split-brain state.
      console.error("kb.entries.rollback_failed", { entry_id: entryId, err: rollbackErr });
    }
    return NextResponse.json(
      { error: "Failed to store vector — entry rolled back" },
      { status: 502 },
    );
  }

  // --- Stamp embedding_id on the Postgres row (same as entryId for 1-to-1 mapping) ---
  await db
    .update(schema.kbEntries)
    .set({ embeddingId: entryId })
    .where(eq(schema.kbEntries.id, entryId));

  // --- Increment taxonomy usage counts (best-effort) ---
  await Promise.all([
    bumpTaxonomy("department", entry.department),
    bumpTaxonomy("topic", entry.topic),
    bumpTaxonomy("issue_type", entry.issue_type),
  ]);

  return NextResponse.json({ id: entryId } satisfies EntriesSuccessResponse, {
    status: 201,
  });
}

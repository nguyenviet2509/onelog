/**
 * POST /api/kb/entries
 *
 * Input headers: Authorization: Bearer <openwebui_jwt>  (optional — access_token in body is primary auth)
 * Input body:    { draftId: string, accessToken: string, edits?: Partial<DraftEntry>, force?: boolean }
 * Output:        { id: string } on success
 *                { dedupHits: DedupHit[] } at 409 when near-duplicate found + force != true
 *
 * Flow:
 *   1. Validate input
 *   2. getDraftByToken(draftId, accessToken) — 404 if not found, 410 if expired
 *   3. Merge draft_json + edits
 *   4. Redact PII on all text fields
 *   5. Embed (title + symptom + root_cause)
 *   6. Dedup check → 409 if hits && !force (do NOT delete draft — allow retry with force)
 *   7. INSERT kb_entries (openwebui_chat_id, created_by from draft)
 *   8. Qdrant upsert → rollback Postgres row if Qdrant fails
 *   9. Increment kb_taxonomy.usage_count for topic + issue_type
 *  10. DELETE draft
 *  11. Return { id }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { ensureBootstrap } from "@/db/bootstrap";
import { getDb, schema } from "@/db/client";
import { getDraftByToken, deleteDraft } from "@/lib/kb/draft-store";
import { redact } from "@/lib/kb/redact";
import { embedText } from "@/lib/kb/embed-client";
import { checkDuplicates, type DedupHit } from "@/lib/kb/dedup";
import { upsertPoint, ensureCollection, type QdrantPayload } from "@/lib/kb/qdrant-client";
import { DraftEntrySchema, type DraftEntry } from "@/lib/kb/summarizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const EditsSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  symptom: z.string().min(1).optional(),
  root_cause: z.string().min(1).optional(),
  fix: z.string().min(1).optional(),
  department: z.enum(["SRE", "DBA", "NetOps", "AppDev", "Security"]).optional(),
  topic: z.string().max(64).optional(),
  issue_type: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

const BodySchema = z.object({
  draftId: z.string().uuid("draftId must be a UUID"),
  accessToken: z.string().min(64).max(64),
  edits: EditsSchema.optional(),
  force: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge draft with optional member edits — edits override draft fields. */
function mergeDraft(draft: DraftEntry, edits?: z.infer<typeof EditsSchema>): DraftEntry {
  if (!edits) return draft;
  return {
    ...draft,
    ...Object.fromEntries(
      Object.entries(edits).filter(([, v]) => v !== undefined),
    ),
  } as DraftEntry;
}

/** Redact PII from all user-visible text fields. */
function redactDraft(entry: DraftEntry): DraftEntry {
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
async function bumpTaxonomy(kind: string, value: string | undefined): Promise<void> {
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

export interface EntriesSuccessResponse {
  id: string;
}

export interface EntryDedupResponse {
  dedupHits: DedupHit[];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  await ensureBootstrap();
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
  const { draftId, accessToken, edits, force } = parsed.data;

  // --- Retrieve draft (token + expiry check) ---
  let draftRecord;
  try {
    draftRecord = await getDraftByToken(draftId, accessToken);
  } catch (err) {
    console.error("kb.entries.getDraft_failed", err);
    return NextResponse.json({ error: "Failed to retrieve draft" }, { status: 500 });
  }

  if (!draftRecord) {
    // Distinguish expired vs not found at query level is expensive; return 410 Gone
    // for both — client must re-summarize if expired.
    return NextResponse.json({ error: "Draft not found or expired" }, { status: 410 });
  }

  // --- Validate draft_json shape (defensive — data was inserted by summarize route) ---
  const draftParsed = DraftEntrySchema.safeParse(draftRecord.draft);
  if (!draftParsed.success) {
    console.error("kb.entries.invalid_draft_json", { draftId, errors: draftParsed.error });
    return NextResponse.json({ error: "Draft data is malformed" }, { status: 422 });
  }

  // --- Merge + redact ---
  const merged = redactDraft(mergeDraft(draftParsed.data, edits));

  // --- Ensure Qdrant collection ---
  try {
    await ensureCollection();
  } catch (err) {
    console.error("kb.entries.qdrant_collection_failed", err);
    return NextResponse.json({ error: "Vector store unavailable" }, { status: 503 });
  }

  // --- Embed (title + symptom + root_cause) ---
  const textToEmbed = [merged.title, merged.symptom, merged.root_cause]
    .filter(Boolean)
    .join(" ");

  let vector: number[];
  try {
    vector = await embedText(textToEmbed);
  } catch (err) {
    console.error("kb.entries.embed_failed", err);
    return NextResponse.json({ error: "Embedding failed" }, { status: 502 });
  }

  // --- Dedup check (skip when force=true) ---
  if (!force) {
    const hits = await checkDuplicates(vector);
    if (hits.length > 0) {
      // Do NOT delete draft — allow member to retry with force=true
      return NextResponse.json(
        { dedupHits: hits } satisfies EntryDedupResponse,
        { status: 409 },
      );
    }
  }

  // --- INSERT kb_entries ---
  let entryId: string;
  try {
    const [row] = await db
      .insert(schema.kbEntries)
      .values({
        openwebuiChatId: draftRecord.openwebuiChatId,
        title: merged.title,
        department: merged.department,
        topic: merged.topic,
        issueType: merged.issue_type,
        tags: merged.tags.length > 0 ? merged.tags : null,
        symptom: merged.symptom,
        rootCause: merged.root_cause,
        fix: merged.fix,
        embeddingId: null, // stamped after Qdrant upsert
        createdBy: draftRecord.openwebuiUserId,
        upvotes: 0,
        verifiedBy: [],
      })
      .returning({ id: schema.kbEntries.id });
    entryId = row.id;
  } catch (err) {
    console.error("kb.entries.insert_failed", err);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }

  // --- Qdrant upsert → rollback Postgres on failure ---
  const qdrantPayload: QdrantPayload = {
    entryId,
    title: merged.title,
    department: merged.department,
    topic: merged.topic,
    issueType: merged.issue_type,
    conversationId: draftRecord.openwebuiChatId,
    createdAt: new Date().toISOString(),
  };

  try {
    await upsertPoint(entryId, vector, qdrantPayload);
  } catch (qdrantErr) {
    console.error("kb.entries.qdrant_upsert_failed_rollback", { entryId, err: qdrantErr });
    try {
      await db.delete(schema.kbEntries).where(eq(schema.kbEntries.id, entryId));
    } catch (rollbackErr) {
      // Orphan row with embedding_id=null — Phase 2 reconcile job sweeps these
      console.error("kb.entries.rollback_failed", { entryId, err: rollbackErr });
    }
    return NextResponse.json({ error: "Failed to store vector — entry rolled back" }, { status: 502 });
  }

  // --- Stamp embedding_id ---
  await db
    .update(schema.kbEntries)
    .set({ embeddingId: entryId, updatedAt: new Date() })
    .where(eq(schema.kbEntries.id, entryId));

  // --- Bump taxonomy usage counts (best-effort) ---
  await Promise.all([
    bumpTaxonomy("department", merged.department),
    bumpTaxonomy("topic", merged.topic),
    bumpTaxonomy("issue_type", merged.issue_type),
  ]);

  // --- Delete draft (cleanup — best-effort after successful commit) ---
  try {
    await deleteDraft(draftId);
  } catch (err) {
    console.warn("kb.entries.delete_draft_failed", { draftId, err });
  }

  return NextResponse.json({ id: entryId } satisfies EntriesSuccessResponse, { status: 201 });
}

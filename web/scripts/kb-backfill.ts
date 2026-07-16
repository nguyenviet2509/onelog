/**
 * KB Backfill Script — one-shot batch conversion of existing conversations.
 *
 * Criteria for inclusion:
 *   - ≥ 3 messages in the conversation
 *   - At least one tool_call part in messages.parts
 *   - Not already in kb_entries (by conversation_id)
 *
 * Rate limit: 5 conversations per minute (env KB_BACKFILL_RPM, default 5).
 * Summarize + insert with verified_by=[], upvotes=0.
 *
 * Usage:
 *   cd web && npx tsx scripts/kb-backfill.ts
 *   cd web && npx tsx scripts/kb-backfill.ts --dry-run
 *
 * Required env: DATABASE_URL, DEEPSEEK_API_KEY (or KB_LLM_MOCK=true for testing)
 *               OPENAI_API_KEY (or KB_LLM_MOCK=true), QDRANT_URL
 */

import "dotenv/config";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { asc, eq, sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { ensureBootstrap } from "../src/db/bootstrap";
import { summarizeConversation } from "../src/lib/kb/summarizer";
import { redact } from "../src/lib/kb/redact";
import { embedText } from "../src/lib/kb/embed-client";
import { checkDuplicates } from "../src/lib/kb/dedup";
import { upsertPoint, ensureCollection, type QdrantPayload } from "../src/lib/kb/qdrant-client";
import { snapTaxonomy } from "../src/lib/kb/taxonomy-snap";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const RPM = parseInt(process.env.KB_BACKFILL_RPM ?? "5", 10);
const DELAY_MS = Math.ceil(60_000 / RPM); // ms between each conversation
const MIN_MESSAGES = 3;
const SEED_USER_ID = 1; // sysadmin

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pg = postgres(url, { max: 2 });
  return { db: drizzle(pg, { schema }), pg };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MessagePart {
  kind: string;
  [key: string]: unknown;
}

function hasToolCall(parts: unknown): boolean {
  if (!Array.isArray(parts)) return false;
  return (parts as MessagePart[]).some((p) => p.kind === "tool");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`KB Backfill${DRY_RUN ? " [DRY RUN]" : ""} — rate ${RPM} conv/min`);

  await ensureBootstrap();
  const { db, pg } = getDb();

  if (!DRY_RUN) {
    await ensureCollection();
  }

  // Find conversations already in kb_entries (to skip)
  const existing = await db
    .select({ conversationId: schema.kbEntries.conversationId })
    .from(schema.kbEntries);
  const existingIds = new Set(existing.map((r) => r.conversationId));

  // Load all conversations with message counts
  const allConvs = await db
    .select({ id: schema.conversations.id, title: schema.conversations.title })
    .from(schema.conversations)
    .orderBy(asc(schema.conversations.createdAt));

  const candidates = allConvs.filter((c) => !existingIds.has(c.id));
  console.log(`Found ${allConvs.length} total conversations, ${candidates.length} candidates`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const conv of candidates) {
    // Load messages
    const messages = await db
      .select({
        role: schema.messages.role,
        content: schema.messages.content,
        parts: schema.messages.parts,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conv.id))
      .orderBy(asc(schema.messages.createdAt));

    // Skip if too few messages
    if (messages.length < MIN_MESSAGES) {
      skipped++;
      continue;
    }

    // Skip if no tool_call in any message
    const hasAnyToolCall = messages.some((m) => hasToolCall(m.parts));
    if (!hasAnyToolCall) {
      skipped++;
      continue;
    }

    console.log(`\n[${processed + 1}] Processing: ${conv.title} (${conv.id})`);

    if (DRY_RUN) {
      console.log(`  → DRY RUN — would summarize ${messages.length} messages`);
      processed++;
      continue;
    }

    try {
      // Summarize
      const draft = await summarizeConversation(messages);
      console.log(`  → draft: "${draft.title}"`);

      // Taxonomy snap
      if (draft.topic) {
        const snap = await snapTaxonomy("topic", draft.topic).catch(() => null);
        if (snap) draft.topic = snap.value;
      }
      if (draft.issue_type) {
        const snap = await snapTaxonomy("issue_type", draft.issue_type).catch(() => null);
        if (snap) draft.issue_type = snap.value;
      }

      // Redact
      const title = redact(draft.title);
      const symptom = redact(draft.symptom);
      const rootCause = redact(draft.root_cause);
      const fix = redact(draft.fix);
      const tags = (draft.tags ?? []).map(redact);

      // Embed
      const vector = await embedText(`${title} ${symptom} ${rootCause}`);

      // Dedup check
      const hits = await checkDuplicates(vector);
      if (hits.length > 0) {
        console.log(`  → SKIP dedup hit: "${hits[0].title}" (score ${hits[0].score.toFixed(3)})`);
        skipped++;
        continue;
      }

      // Insert Postgres
      const [{ id: entryId }] = await db
        .insert(schema.kbEntries)
        .values({
          conversationId: conv.id,
          title,
          department: draft.department,
          topic: draft.topic,
          issueType: draft.issue_type,
          tags: tags.length > 0 ? tags : null,
          symptom,
          rootCause,
          fix,
          embeddingId: null,
          createdBy: SEED_USER_ID,
          upvotes: 0,
          verifiedBy: [],
        })
        .returning({ id: schema.kbEntries.id });

      // Upsert Qdrant
      const payload: QdrantPayload = {
        entryId,
        title,
        department: draft.department,
        topic: draft.topic,
        issueType: draft.issue_type,
        conversationId: conv.id,
        createdAt: new Date().toISOString(),
      };
      await upsertPoint(entryId, vector, payload);

      // Stamp embedding_id
      await db
        .update(schema.kbEntries)
        .set({ embeddingId: entryId })
        .where(eq(schema.kbEntries.id, entryId));

      console.log(`  → saved: ${entryId}`);
      processed++;
    } catch (err) {
      console.error(`  → FAILED: ${(err as Error).message}`);
      failed++;
    }

    // Rate limit
    await sleep(DELAY_MS);
  }

  await pg.end({ timeout: 2 });

  console.log(`\nBackfill complete: ${processed} saved, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

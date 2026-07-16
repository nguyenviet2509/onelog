#!/usr/bin/env npx tsx
/**
 * KB Backfill — import existing OpenWebUI chats into the KB.
 *
 * Uses OPENWEBUI_ADMIN_API_KEY to paginate all chats, summarizes each,
 * and inserts directly (skipping review) with verified=false.
 *
 * Env vars required:
 *   DATABASE_URL               — Postgres connection string
 *   OPENWEBUI_URL              — e.g. http://openwebui:8080
 *   OPENWEBUI_ADMIN_API_KEY    — admin API key (not a JWT)
 *   DEEPSEEK_API_KEY or KB_LLM_MOCK=true
 *   OPENAI_API_KEY or EMBED_MOCK=true
 *   QDRANT_URL
 *
 * CLI flags:
 *   --dry-run         Print what would be inserted, no writes
 *   --limit N         Stop after N chats processed
 *   --user-id X       Only process chats belonging to OpenWebUI user X
 *
 * Rate: 5 chats/min (one per 12s) to avoid hammering LLM APIs.
 */

import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../src/db/client";
import { ensureBootstrap } from "../src/db/bootstrap";
import { listAllChats, fetchChatMessages } from "../src/lib/kb/openwebui-client";
import { summarizeConversation } from "../src/lib/kb/summarizer";
import { snapTaxonomy } from "../src/lib/kb/taxonomy-snap";
import { redact } from "../src/lib/kb/redact";
import { embedText } from "../src/lib/kb/embed-client";
import { checkDuplicates } from "../src/lib/kb/dedup";
import { upsertPoint, ensureCollection, type QdrantPayload } from "../src/lib/kb/qdrant-client";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const MAX_CHATS = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? "0", 10) : 0;
const userIdx = args.indexOf("--user-id");
const FILTER_USER = userIdx >= 0 ? args[userIdx + 1] : undefined;

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`ERROR: ${name} is not set. Aborting.`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Rate limiter — 5 chats/min = 1 per 12s
// ---------------------------------------------------------------------------

const RATE_INTERVAL_MS = 12_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Check if chat already in KB
// ---------------------------------------------------------------------------

async function isAlreadyIndexed(chatId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.kbEntries.id })
    .from(schema.kbEntries)
    .where(eq(schema.kbEntries.openwebuiChatId, chatId))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Insert entry directly (no draft, no review)
// ---------------------------------------------------------------------------

async function insertEntry(
  chatId: string,
  userId: string,
  draft: Awaited<ReturnType<typeof summarizeConversation>>,
): Promise<string> {
  const db = getDb();

  const redacted = {
    ...draft,
    title: redact(draft.title),
    symptom: redact(draft.symptom),
    root_cause: redact(draft.root_cause),
    fix: redact(draft.fix),
    tags: draft.tags.map(redact),
  };

  const textToEmbed = [redacted.title, redacted.symptom, redacted.root_cause]
    .filter(Boolean)
    .join(" ");
  const vector = await embedText(textToEmbed);

  // Dedup check — skip if top-1 > 0.9
  const hits = await checkDuplicates(vector);
  if (hits.length > 0) {
    console.log(
      `  SKIP dedup: ${hits[0]!.score.toFixed(3)} match "${hits[0]!.title}"`,
    );
    return "";
  }

  await ensureCollection();

  const [row] = await db
    .insert(schema.kbEntries)
    .values({
      openwebuiChatId: chatId,
      title: redacted.title,
      department: redacted.department,
      topic: redacted.topic,
      issueType: redacted.issue_type,
      tags: redacted.tags.length > 0 ? redacted.tags : null,
      symptom: redacted.symptom,
      rootCause: redacted.root_cause,
      fix: redacted.fix,
      embeddingId: null,
      createdBy: userId,
      upvotes: 0,
      verifiedBy: [],
    })
    .returning({ id: schema.kbEntries.id });

  const entryId = row.id;

  const qdrantPayload: QdrantPayload = {
    entryId,
    title: redacted.title,
    department: redacted.department,
    topic: redacted.topic,
    issueType: redacted.issue_type,
    conversationId: chatId,
    createdAt: new Date().toISOString(),
  };

  await upsertPoint(entryId, vector, qdrantPayload);

  await db
    .update(schema.kbEntries)
    .set({ embeddingId: entryId, updatedAt: new Date() })
    .where(eq(schema.kbEntries.id, entryId));

  // Bump taxonomy usage counts
  for (const [kind, value] of [
    ["department", redacted.department],
    ["topic", redacted.topic],
    ["issue_type", redacted.issue_type],
  ] as const) {
    if (value) {
      try {
        await db.execute(
          sql`UPDATE kb_taxonomy SET usage_count = usage_count + 1
              WHERE kind = ${kind} AND value = ${value}`,
        );
      } catch {
        // best-effort
      }
    }
  }

  return entryId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const adminKey = requireEnv("OPENWEBUI_ADMIN_API_KEY");

  console.log("KB Backfill starting...");
  console.log(`  DRY_RUN   : ${DRY_RUN}`);
  console.log(`  MAX_CHATS : ${MAX_CHATS > 0 ? MAX_CHATS : "unlimited"}`);
  console.log(`  FILTER_USER: ${FILTER_USER ?? "all"}`);
  console.log("");

  if (!DRY_RUN) {
    await ensureBootstrap();
  }

  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let pageSkip = 0;
  const PAGE_SIZE = 50;

  outer: while (true) {
    let chats;
    try {
      chats = await listAllChats(adminKey, pageSkip, PAGE_SIZE);
    } catch (err) {
      console.error("Failed to list chats:", err);
      break;
    }

    if (chats.length === 0) {
      console.log("No more chats — done.");
      break;
    }

    for (const chat of chats) {
      if (MAX_CHATS > 0 && processed >= MAX_CHATS) {
        console.log(`Reached --limit ${MAX_CHATS}, stopping.`);
        break outer;
      }

      // Filter by user if requested
      if (FILTER_USER && chat.user_id !== FILTER_USER) {
        continue;
      }

      processed++;
      console.log(`[${processed}] chat=${chat.id} title="${chat.title ?? "(untitled)"}"`);

      // Skip already indexed
      if (!DRY_RUN && (await isAlreadyIndexed(chat.id))) {
        console.log("  SKIP already indexed");
        skipped++;
        continue;
      }

      // Fetch messages
      let messages;
      try {
        messages = await fetchChatMessages(chat.id, adminKey);
      } catch (err) {
        console.warn(`  FAIL fetchMessages: ${(err as Error).message}`);
        failed++;
        continue;
      }

      if (messages.length === 0) {
        console.log("  SKIP no messages");
        skipped++;
        continue;
      }

      // Summarize
      let draft;
      try {
        draft = await summarizeConversation(messages);
      } catch (err) {
        console.warn(`  FAIL summarize: ${(err as Error).message}`);
        failed++;
        continue;
      }

      // Taxonomy snap
      try {
        if (draft.topic) {
          const snap = await snapTaxonomy("topic", draft.topic);
          draft = { ...draft, topic: snap.value };
        }
        if (draft.issue_type) {
          const snap = await snapTaxonomy("issue_type", draft.issue_type);
          draft = { ...draft, issue_type: snap.value };
        }
      } catch {
        // non-fatal
      }

      if (DRY_RUN) {
        console.log(`  DRY title="${draft.title}" dept=${draft.department ?? "-"} topic=${draft.topic ?? "-"}`);
        inserted++;
        continue;
      }

      // Insert
      try {
        const entryId = await insertEntry(chat.id, chat.user_id ?? "backfill", draft);
        if (entryId) {
          console.log(`  OK  entry=${entryId}`);
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn(`  FAIL insert: ${(err as Error).message}`);
        failed++;
      }

      // Rate limit: 5 chats/min
      await sleep(RATE_INTERVAL_MS);
    }

    pageSkip += PAGE_SIZE;
  }

  console.log("");
  console.log("=== Backfill complete ===");
  console.log(`  Processed : ${processed}`);
  console.log(`  Inserted  : ${inserted}`);
  console.log(`  Skipped   : ${skipped}`);
  console.log(`  Failed    : ${failed}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

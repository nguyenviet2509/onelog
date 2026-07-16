/**
 * Taxonomy snap-to-existing — normalize LLM-proposed topic/issue_type values.
 *
 * Strategy (in order):
 *   1. Exact match (case-insensitive)
 *   2. Levenshtein normalized similarity ≥ KB_SNAP_THRESHOLD (default 0.85)
 *   3. Embed cosine similarity ≥ KB_SNAP_THRESHOLD
 *   4. Insert new taxonomy row (auto-create)
 *
 * Env: KB_SNAP_THRESHOLD (default 0.85)
 */

import { getDb, schema } from "@/db/client";
import { and, eq } from "drizzle-orm";
import { embedText } from "./embed-client";

const SNAP_THRESHOLD = parseFloat(process.env.KB_SNAP_THRESHOLD ?? "0.85");

export interface SnapResult {
  value: string;
  snapped: boolean;
  from?: string; // original proposal if snapped to a different value
}

/**
 * Normalize a levenshtein distance to [0, 1] similarity score.
 * Uses the standard formula: 1 - distance / max(len_a, len_b).
 */
function levenshteinSimilarity(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0 && bl === 0) return 1;
  if (al === 0 || bl === 0) return 0;

  // DP table — O(n*m) time/space, fine for short taxonomy labels (<64 chars)
  const dp: number[][] = Array.from({ length: al + 1 }, (_, i) =>
    Array.from({ length: bl + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const dist = dp[al][bl];
  return 1 - dist / Math.max(al, bl);
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Snap a proposed taxonomy value to the nearest existing value, or insert new.
 *
 * @param kind   'topic' | 'issue_type' | 'department'
 * @param proposal  LLM-proposed string (may be raw, unnormalized)
 * @returns SnapResult with the canonical value and whether snapping occurred
 */
export async function snapTaxonomy(
  kind: "topic" | "issue_type" | "department",
  proposal: string,
): Promise<SnapResult> {
  if (!proposal.trim()) {
    return { value: proposal, snapped: false };
  }

  const db = getDb();
  const normalized = proposal.trim().toLowerCase();

  // Load all existing values for this kind
  const rows = await db
    .select({ value: schema.kbTaxonomy.value })
    .from(schema.kbTaxonomy)
    .where(eq(schema.kbTaxonomy.kind, kind));

  const existingValues = rows.map((r) => r.value);

  // 1. Exact match (case-insensitive)
  // NOTE: do NOT increment usage_count here — only the /api/kb/entries commit path bumps it.
  const exact = existingValues.find((v) => v.toLowerCase() === normalized);
  if (exact) {
    const snapped = exact !== proposal;
    return { value: exact, snapped, from: snapped ? proposal : undefined };
  }

  // 2. Levenshtein similarity
  let bestLev = { value: "", score: 0 };
  for (const v of existingValues) {
    const score = levenshteinSimilarity(normalized, v.toLowerCase());
    if (score > bestLev.score) bestLev = { value: v, score };
  }
  if (bestLev.score >= SNAP_THRESHOLD) {
    return { value: bestLev.value, snapped: true, from: proposal };
  }

  // 3. Embed similarity (only when we have existing values to compare against)
  if (existingValues.length > 0) {
    try {
      const proposalVec = await embedText(proposal);
      let bestEmbed = { value: "", score: 0 };

      for (const v of existingValues) {
        const vec = await embedText(v);
        const score = cosineSimilarity(proposalVec, vec);
        if (score > bestEmbed.score) bestEmbed = { value: v, score };
      }

      if (bestEmbed.score >= SNAP_THRESHOLD) {
        return { value: bestEmbed.value, snapped: true, from: proposal };
      }
    } catch (err) {
      // Embed failure: fall through to insert new value
      console.warn("kb.taxonomy_snap.embed_failed", { kind, proposal, err });
    }
  }

  // 4. Insert new taxonomy row with usage_count=0.
  //    ON CONFLICT handles race where two concurrent summaries propose the same new value
  //    (UNIQUE constraint on (kind, value) in DDL).
  //    If INSERT loses the race, SELECT the winner row so caller gets a valid value.
  const newValue = proposal.trim();
  const inserted = await db
    .insert(schema.kbTaxonomy)
    .values({ kind, value: newValue, usageCount: 0 })
    .onConflictDoNothing()
    .returning({ value: schema.kbTaxonomy.value });

  if (inserted.length === 0) {
    // Race: another request inserted this value first — fetch it
    const [existing] = await db
      .select({ value: schema.kbTaxonomy.value })
      .from(schema.kbTaxonomy)
      .where(and(eq(schema.kbTaxonomy.kind, kind), eq(schema.kbTaxonomy.value, newValue)));
    if (existing) return { value: existing.value, snapped: false };
  }

  return { value: newValue, snapped: false };
}

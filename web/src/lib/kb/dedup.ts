/**
 * Semantic dedup check — query Qdrant top-3 before inserting a new KB entry.
 *
 * If top-1 score exceeds KB_DEDUP_THRESHOLD (default 0.9), the caller should
 * return dedupHits to the client and wait for an explicit force=true flag
 * before proceeding with the insert.
 */

import { search, type SearchHit } from "./qdrant-client";

const DEDUP_THRESHOLD = parseFloat(process.env.KB_DEDUP_THRESHOLD ?? "0.9");

export interface DedupHit {
  id: string;
  title: string;
  score: number;
}

/**
 * Check for near-duplicate entries in Qdrant.
 * Returns top-3 hits that exceed the dedup threshold.
 * Empty array means no duplicates detected — safe to insert.
 */
export async function checkDuplicates(vector: number[]): Promise<DedupHit[]> {
  let hits: SearchHit[];
  try {
    hits = await search(vector, 3);
  } catch (err) {
    // If Qdrant is unreachable during check, fail open (allow insert)
    // and log — prevents dedup from blocking KB creation when Qdrant is cold.
    console.warn("kb.dedup.qdrant_unreachable", err);
    return [];
  }

  return hits
    .filter((h) => h.score >= DEDUP_THRESHOLD)
    .map((h) => ({
      id: String(h.id),
      title: h.payload?.title ?? "(untitled)",
      score: h.score,
    }));
}

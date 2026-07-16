/**
 * Qdrant REST API wrapper — minimal surface for KB Phase 1.
 *
 * Env vars:
 *   QDRANT_URL              — required, e.g. http://localhost:6333
 *   QDRANT_API_KEY          — optional (Qdrant Cloud)
 *   KB_QDRANT_COLLECTION    — default kb_resolved
 *
 * All functions throw on non-2xx unless documented otherwise.
 * Collection dimension: 1536 (text-embedding-3-small), distance: Cosine.
 */

const COLLECTION = process.env.KB_QDRANT_COLLECTION ?? "kb_resolved";
const DIM = 1536;

function qdrantUrl(): string {
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error("QDRANT_URL not set");
  return url.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const key = process.env.QDRANT_API_KEY;
  return key ? { "api-key": key } : {};
}

async function qdrantFetch(path: string, init: RequestInit): Promise<unknown> {
  const url = `${qdrantUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Qdrant ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Ensure `kb_resolved` collection exists with correct dim + Cosine distance.
 * Idempotent — safe to call on every server start.
 */
export async function ensureCollection(): Promise<void> {
  // Check if collection already exists
  try {
    await qdrantFetch(`/collections/${COLLECTION}`, { method: "GET" });
    return; // already exists
  } catch {
    // 404 or error → create it
  }

  await qdrantFetch(`/collections/${COLLECTION}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: {
        size: DIM,
        distance: "Cosine",
      },
    }),
  });
}

export interface QdrantPayload {
  entryId: string;
  title: string;
  department?: string;
  topic?: string;
  issueType?: string;
  conversationId: string;
  createdAt: string;
}

/**
 * Upsert a single point into the KB collection.
 * id: UUID string (used as Qdrant point id by converting to deterministic format).
 */
export async function upsertPoint(
  id: string,
  vector: number[],
  payload: QdrantPayload,
): Promise<void> {
  await qdrantFetch(`/collections/${COLLECTION}/points`, {
    method: "PUT",
    body: JSON.stringify({
      points: [{ id: uuidToQdrantId(id), vector, payload }],
    }),
  });
}

export interface SearchHit {
  id: string | number;
  score: number;
  payload: QdrantPayload;
}

/**
 * Vector similarity search. Returns top `limit` results.
 * Optional filter: { must: [{ key, match: { value } }] }
 */
export async function search(
  vector: number[],
  limit: number,
  filter?: Record<string, unknown>,
): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const res = (await qdrantFetch(`/collections/${COLLECTION}/points/search`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { result: SearchHit[] };

  return res.result ?? [];
}

/**
 * Delete a point by entry UUID.
 */
export async function deletePoint(id: string): Promise<void> {
  await qdrantFetch(`/collections/${COLLECTION}/points/delete`, {
    method: "POST",
    body: JSON.stringify({ points: [uuidToQdrantId(id)] }),
  });
}

/**
 * Qdrant accepts UUID strings as point ids natively when passed as string.
 * We store entry UUID → keep 1-to-1 mapping by passing the UUID directly.
 * Qdrant REST expects the id field as either integer or UUID string.
 */
function uuidToQdrantId(id: string): string {
  return id;
}

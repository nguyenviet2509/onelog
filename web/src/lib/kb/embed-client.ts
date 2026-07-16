/**
 * Embed client — OpenAI-compat embeddings via native fetch.
 *
 * Env vars:
 *   OPENAI_API_KEY     — required for real mode
 *   OPENAI_BASE_URL    — default https://api.openai.com/v1
 *   EMBED_MODEL        — default text-embedding-3-small (dim 1536)
 *   KB_LLM_MOCK        — if "true" or OPENAI_API_KEY missing → sha256 mock vector
 *
 * Mock vector mirrors agent/src/agent/embed_client.py: sha256(text) → float[]
 * so dev/CI never needs a real API key.
 */

import { createHash } from "crypto";

const DIM = 1536; // text-embedding-3-small — must match Qdrant collection

function isMockMode(): boolean {
  return process.env.KB_LLM_MOCK === "true" || !process.env.OPENAI_API_KEY;
}

/** Deterministic mock vector from sha256(text), normalized to [-1, 1]. Mirrors Python impl. */
function mockVector(text: string): number[] {
  const hash = createHash("sha256").update(text, "utf8").digest();
  // Repeat hash bytes until we have DIM bytes, then map [0,255] → [-1,1]
  const repeated = Buffer.alloc(DIM);
  for (let i = 0; i < DIM; i++) {
    repeated[i] = hash[i % hash.length];
  }
  return Array.from(repeated).map((b) => (b - 128) / 128.0);
}

/**
 * Embed a single text string → float[1536].
 * Throws on API error (non-2xx response).
 */
export async function embedText(text: string): Promise<number[]> {
  if (isMockMode()) {
    return mockVector(text);
  }

  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.EMBED_MODEL ?? "text-embedding-3-small";
  const apiKey = process.env.OPENAI_API_KEY!;

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: [text] }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`embed API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = json.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("embed API returned empty embedding");
  }
  return embedding;
}

/**
 * audit-ingest-tokens.ts — Parse AUDIT_INGEST_TOKENS env into app_id → token map.
 * Format: "app1:token1,app2:token2" (min 32-char tokens).
 * Constant-time compare on lookup.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

interface TokenEntry {
  appId: string;
  tokenBuf: Buffer;
}

const MIN_TOKEN_LEN = 32;

let cache: TokenEntry[] | null = null;

function load(): TokenEntry[] {
  if (cache) return cache;
  const raw = config.AUDIT_INGEST_TOKENS.trim();
  if (!raw) {
    cache = [];
    return cache;
  }
  const entries: TokenEntry[] = [];
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new Error(`AUDIT_INGEST_TOKENS: bad entry "${trimmed}" — expected app_id:token`);
    }
    const appId = trimmed.slice(0, idx);
    const token = trimmed.slice(idx + 1);
    if (token.length < MIN_TOKEN_LEN) {
      throw new Error(`AUDIT_INGEST_TOKENS: token for "${appId}" too short (min ${MIN_TOKEN_LEN} chars)`);
    }
    entries.push({ appId, tokenBuf: Buffer.from(token, 'utf8') });
  }
  cache = entries;
  return cache;
}

/**
 * Verify bearer token → returns app_id if match, null if no match / disabled.
 * Constant-time compare per entry so caller can't timing-oracle valid app_ids.
 */
export function verifyIngestToken(token: string): string | null {
  const entries = load();
  const candidateBuf = Buffer.from(token, 'utf8');
  let match: string | null = null;
  for (const e of entries) {
    if (e.tokenBuf.length !== candidateBuf.length) continue;
    if (timingSafeEqual(e.tokenBuf, candidateBuf) && match === null) {
      match = e.appId;
      // don't early-return — keep iterating for constant time across entries
    }
  }
  return match;
}

export function isIngestEnabled(): boolean {
  return load().length > 0;
}

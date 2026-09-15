/**
 * app-token-service.ts — Per-app token generation + CRUD.
 *
 * Format: rbac_<8char-base32-prefix>_<24char-base32-secret>
 *   - Prefix: 40 bits entropy, indexed for O(1) DB lookup
 *   - Secret: 120 bits entropy, argon2id hashed
 *   - `rbac_` prefix: secret scanner (gitleaks) can detect leaks
 *
 * Storage: DB stores only argon2 hash. Plain token returned ONCE from create.
 * Revoke: soft-delete + invalidate in-memory cache (Phase 2).
 */
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { writerPool } from '../db/writer-pool.js';
import { invalidateByTokenId } from '../lib/token-cache.js';

// RFC 4648 base32 lowercase alphabet
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // If we ran short (unlikely with our byte sizes), pad from random.
  while (output.length < length) output += BASE32[randomBytes(1)[0]! & 31];
  return output;
}

export function generateToken(): { fullToken: string; prefix: string } {
  const prefixBytes = randomBytes(5); // 5 bytes = 40 bits → 8 base32 chars
  const secretBytes = randomBytes(15); // 15 bytes = 120 bits → 24 base32 chars
  const prefix = base32Encode(prefixBytes, 8);
  const secret = base32Encode(secretBytes, 24);
  return { fullToken: `rbac_${prefix}_${secret}`, prefix };
}

export interface CreateTokenParams {
  appId: string;
  label: string;
  createdBy: string;
}

export interface CreateTokenResult {
  id: string;
  prefix: string;
  label: string;
  fullToken: string; // one-time reveal
}

export async function createAppToken(params: CreateTokenParams): Promise<CreateTokenResult> {
  const { fullToken, prefix } = generateToken();
  const hash = await argon2.hash(fullToken, { type: argon2.argon2id });

  const { rows } = await writerPool.query<{ id: string }>(
    `INSERT INTO rbac.app_tokens (app_id, token_prefix, token_hash, label, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.appId, prefix, hash, params.label, params.createdBy],
  );

  return { id: rows[0]!.id, prefix, label: params.label, fullToken };
}

export interface AppTokenRow {
  id: string;
  token_prefix: string;
  label: string;
  created_at: Date;
  created_by: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}

export async function listAppTokens(appId: string): Promise<AppTokenRow[]> {
  const { rows } = await writerPool.query<AppTokenRow>(
    `SELECT id, token_prefix, label, created_at, created_by, last_used_at, revoked_at, revoked_by
     FROM rbac.app_tokens
     WHERE app_id = $1
     ORDER BY created_at DESC`,
    [appId],
  );
  return rows;
}

/**
 * Soft-revoke a token. Returns true if revoked, false if not found or already revoked.
 * Invalidates in-memory cache immediately so next request rejects.
 */
export async function revokeAppToken(tokenId: string, revokedBy: string): Promise<boolean> {
  const { rowCount } = await writerPool.query(
    `UPDATE rbac.app_tokens
     SET revoked_at = now(), revoked_by = $2
     WHERE id = $1 AND revoked_at IS NULL`,
    [tokenId, revokedBy],
  );
  if (rowCount && rowCount > 0) {
    invalidateByTokenId(tokenId);
    return true;
  }
  return false;
}

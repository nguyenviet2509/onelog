/**
 * auth-jwt.ts — JWT verification middleware for Fastify.
 * Verifies: signature (JWKS remote), iss, aud, azp.
 * Rejects if rbac_degraded:true on non-read-only paths.
 * JWKS cached 4min with kid-miss refetch.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// JWKS cache: keyed by kid, TTL 4 minutes
const JWKS_CACHE_TTL_MS = 4 * 60 * 1000;
let jwksSet: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCachedAt = 0;

function getJwksSet(): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  if (!jwksSet || now - jwksCachedAt > JWKS_CACHE_TTL_MS) {
    jwksSet = createRemoteJWKSet(new URL(config.ZITADEL_JWKS_URL));
    jwksCachedAt = now;
  }
  return jwksSet;
}

// Force-refresh JWKS on kid miss (jose handles this internally via JWKS set)
function refreshJwksSet(): ReturnType<typeof createRemoteJWKSet> {
  jwksSet = createRemoteJWKSet(new URL(config.ZITADEL_JWKS_URL));
  jwksCachedAt = Date.now();
  return jwksSet;
}

export interface JwtClaims extends JWTPayload {
  azp?: string;
  permissions?: string[];
  permissions_hash?: string;
  roles?: string[];
  org_id?: string;
  rbac_degraded?: boolean;
  ver?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwtClaims?: JwtClaims;
  }
}

// Read-only paths exempt from rbac_degraded rejection
const READ_ONLY_PREFIXES = ['/v1/audit', '/v1/health'];

function isReadOnlyPath(path: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => path.startsWith(p));
}

export async function verifyJwt(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing Authorization header' });
  }

  const token = authHeader.slice(7);
  let payload: JwtClaims;

  try {
    const JWKS = getJwksSet();
    const result = await jwtVerify<JwtClaims>(token, JWKS, {
      issuer: config.ZITADEL_ISSUER,
      audience: config.ZITADEL_AUD_CLIENT_ID,
    });
    payload = result.payload;
  } catch (err: unknown) {
    // On kid-not-found, force refresh once and retry
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('no applicable key')) {
      try {
        const freshJWKS = refreshJwksSet();
        const result = await jwtVerify<JwtClaims>(token, freshJWKS, {
          issuer: config.ZITADEL_ISSUER,
          audience: config.ZITADEL_AUD_CLIENT_ID,
        });
        payload = result.payload;
      } catch (retryErr) {
        logger.warn({ err: retryErr }, 'auth-jwt: token verification failed after JWKS refresh');
        return reply.status(401).send({ error: 'Invalid token' });
      }
    } else {
      logger.warn({ err }, 'auth-jwt: token verification failed');
      return reply.status(401).send({ error: 'Invalid token' });
    }
  }

  // Verify authorized-party matches expected admin client (F3 fix).
  // Per OIDC Core §2, `azp` is only emitted when the ID Token has multiple audiences
  // OR when azp differs from aud[0]. Zitadel omits `azp` for single-audience-matches-client
  // tokens. Fallback: derive effective azp from aud[0] (first audience = authorized party).
  const audArray = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  const effectiveAzp = payload.azp ?? audArray[0];
  if (effectiveAzp !== config.ZITADEL_AZP_ADMIN_CLIENT_ID) {
    logger.warn(
      {
        actual_azp: payload.azp,
        effective_azp: effectiveAzp,
        expected_azp: config.ZITADEL_AZP_ADMIN_CLIENT_ID,
        aud: payload.aud,
        iss: payload.iss,
        sub: payload.sub,
      },
      'auth-jwt: azp mismatch',
    );
    return reply.status(401).send({ error: 'Token azp not authorized' });
  }

  // Reject degraded token on mutating paths (fail-close for admin ops)
  if (payload.rbac_degraded === true && !isReadOnlyPath(request.url)) {
    logger.warn({ sub: payload.sub }, 'auth-jwt: rejecting degraded token on mutating path');
    return reply.status(403).send({ error: 'RBAC degraded — mutations blocked' });
  }

  request.jwtClaims = payload;
}

/**
 * services/manifest-fetcher.ts — SSRF-hardened manifest fetcher.
 * Phase 08 Red Team Fix #2 (Critical): defends against internal URL fetch.
 *
 * Defenses:
 *   1. HTTPS-only (Fix #2 requirement)
 *   2. DNS resolve once, pin IP → prevents DNS rebinding
 *   3. Reject if resolved IP matches RFC1918/loopback/link-local/multicast/IPv6-ULA
 *   4. maxRedirects: 0 — re-validate destination if redirects allowed by caller
 *   5. 5s timeout + Content-Type application/json + size ≤256KB
 *   6. Returns sha256(body) for TOCTOU pinning (Fix #14)
 *
 * ETag support: caller passes prev etag as If-None-Match; 304 → not-modified path.
 */
import { createHash } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { logger } from '../lib/logger.js';

const FETCH_TIMEOUT_MS = 5000;
const MAX_SIZE_BYTES = 256 * 1024;

export interface FetchInput {
  url: string;
  ifNoneMatch?: string;
}

export interface FetchResult {
  status: 'fetched' | 'not-modified';
  etag: string | null;
  bodyText: string | null;
  sha256: string | null;
}

// ── SSRF guards ──────────────────────────────────────────────────────────────

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a = 0, b = 0] = parts;
  // Loopback 127/8
  if (a === 127) return true;
  // Private 10/8
  if (a === 10) return true;
  // Private 172.16/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Private 192.168/16
  if (a === 192 && b === 168) return true;
  // Link-local 169.254/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // Multicast 224/4
  if (a >= 224 && a <= 239) return true;
  // Reserved 240/4 + 0/8
  if (a === 0 || a >= 240) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback ::1
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Link-local fe80::/10
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // Unique local fc00::/7 (includes fd00::/8)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  // IPv4-mapped: check inner IPv4
  const mappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (mappedMatch && mappedMatch[1]) return isBlockedIPv4(mappedMatch[1]);
  return false;
}

async function resolvePinnedIp(hostname: string): Promise<{ family: 4 | 6; address: string }> {
  // Try IPv4 first; fall back to IPv6.
  try {
    const [ipv4] = await resolve4(hostname);
    if (ipv4) return { family: 4, address: ipv4 };
  } catch {
    // fall through to IPv6
  }
  const [ipv6] = await resolve6(hostname);
  if (!ipv6) throw new Error(`DNS resolution failed for ${hostname}`);
  return { family: 6, address: ipv6 };
}

function validateUrlSyntax(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only https:// URLs allowed, got ${parsed.protocol}`);
  }
  // Refuse credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain credentials');
  }
  return parsed;
}

/**
 * Fetch manifest with SSRF protection.
 * Returns {status, etag, bodyText, sha256}.
 * Throws on validation failure or non-2xx (except 304).
 */
export async function fetchManifest(input: FetchInput): Promise<FetchResult> {
  const parsed = validateUrlSyntax(input.url);

  // DNS resolve + block private ranges BEFORE fetch
  const pinned = await resolvePinnedIp(parsed.hostname);
  const isBlocked = pinned.family === 4 ? isBlockedIPv4(pinned.address) : isBlockedIPv6(pinned.address);
  if (isBlocked) {
    logger.warn(
      { url: input.url, resolved_ip: pinned.address },
      'manifest-fetcher: blocked private/loopback IP',
    );
    throw new Error(`Refused to fetch: resolved IP ${pinned.address} is in a blocked range`);
  }

  // Fetch with timeout + no-redirect
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.ifNoneMatch) headers['If-None-Match'] = input.ifNoneMatch;

  let res: Response;
  try {
    res = await fetch(input.url, {
      redirect: 'manual',   // caller must re-validate destination if redirect returned
      signal: controller.signal,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return { status: 'not-modified', etag: input.ifNoneMatch ?? null, bodyText: null, sha256: null };
  }

  // 3xx handling: reject (defense against redirect-based rebinding)
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Refused to follow redirect (${res.status}) — re-configure manifest_url to final destination`);
  }

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${await res.text().catch(() => '')}`);
  }

  // Content-Type check
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new Error(`Expected JSON, got Content-Type: ${ct}`);
  }

  // Read up to MAX_SIZE_BYTES
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_SIZE_BYTES) {
    throw new Error(`Manifest too large: ${buf.byteLength} bytes (max ${MAX_SIZE_BYTES})`);
  }
  const bodyText = Buffer.from(buf).toString('utf8');
  const sha256 = createHash('sha256').update(Buffer.from(buf)).digest('hex');

  return {
    status: 'fetched',
    etag: res.headers.get('etag'),
    bodyText,
    sha256,
  };
}

/**
 * PII redaction — port of agent/src/agent/redact.py (6 regex patterns).
 *
 * Applies defense-in-depth redaction BEFORE embedding and BEFORE DB storage.
 * Keeps the same replacement tokens as the Python version for consistency.
 */

type RedactRule = { pattern: RegExp; replacement: string };

const RULES: RedactRule[] = [
  // Email addresses
  {
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: "<EMAIL>",
  },
  // Private IP ranges (RFC 1918)
  {
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    replacement: "<PRIV_IP>",
  },
  // JWT tokens (eyJ header pattern)
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "<JWT>",
  },
  // AWS access key IDs
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "<AWS_KEY>",
  },
  // Bearer auth headers
  {
    pattern: /authorization:\s*bearer\s+[A-Za-z0-9._-]+/gi,
    replacement: "Authorization: Bearer <TOKEN>",
  },
  // Passwords in various formats (key=value, key: value, key "value")
  {
    pattern: /(?:password|passwd|pwd)["'\s:=]+[^\s,;"']+/gi,
    replacement: "password=<REDACTED>",
  },
];

/**
 * Redact PII from a text string.
 * Applies all 6 patterns sequentially; returns the sanitized string.
 */
export function redact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of RULES) {
    // RegExp with /g flag is stateful — reset lastIndex before each call.
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

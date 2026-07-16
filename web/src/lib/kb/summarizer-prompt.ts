/**
 * System prompt and evidence extraction for the KB summarizer.
 *
 * OpenWebUI pivot: input is OpenWebUI messages [{role, content, timestamp?, citations?}].
 * OpenWebUI does NOT have Anthropic tool_call structured parts — evidence comes from
 * assistant text + user context. If RAG plugin attached citations, they are extracted too.
 *
 * Truncates evidence to MAX_EVIDENCE_CHARS to stay within ~8K token budget.
 */

export const SYSTEM_PROMPT = `You are a KB summarizer for a technical operations team.
Extract a structured knowledge base entry from the conversation provided.
Base your answer ONLY on evidence in the conversation — do NOT invent facts.

Return a JSON object with exactly these fields:
{
  "title":       "<concise title, max 80 chars>",
  "symptom":     "<observable symptoms that triggered investigation>",
  "root_cause":  "<confirmed root cause, grounded in tool output>",
  "fix":         "<step-by-step remediation applied>",
  "department":  "<one of: SRE | DBA | NetOps | AppDev | Security>",
  "topic":       "<short technical topic, e.g. mysql, rsyslog, disk, ssh, vmalert>",
  "issue_type":  "<short issue label, e.g. disk-full, brute-force, oom, crash-loop>",
  "tags":        ["<tag1>", "<tag2>"]
}

Rules:
- symptom/root_cause/fix must come directly from conversation evidence.
- If root cause is uncertain, write "Unknown — investigation inconclusive".
- tags: include hostnames, service names, error codes found in messages.
- All text fields: plain text only, no markdown.
- Respond with ONLY the JSON object, no preamble.`;

/** Max characters of evidence to send (approx 8K tokens at ~4 chars/token). */
const MAX_EVIDENCE_CHARS = 32_000;

/**
 * OpenWebUI message format (REST API response).
 * citations: optional RAG plugin citations array.
 */
export interface OpenWebUIMessage {
  role: string;
  content: string;
  timestamp?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RAG citations schema varies by plugin version
  citations?: any[];
}

/**
 * Legacy interface kept for backward compatibility — summarizer.ts uses RawMessage.
 * OpenWebUI messages satisfy this type via duck-typing (role + content are present).
 */
export interface RawMessage {
  role: string;
  content: string;
  parts?: unknown;
}

/**
 * Build evidence string from OpenWebUI messages.
 * - Include all user messages for context (they describe the problem).
 * - Include all assistant messages for the solution.
 * - Extract RAG citations if present (OpenWebUI RAG plugin attaches them).
 * - Truncate from the middle if over budget — preserving start (context) + end (resolution).
 */
export function buildEvidence(messages: RawMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    // Cast to OpenWebUI shape — parts field unused in this pipeline
    const owMsg = msg as OpenWebUIMessage;

    if (!owMsg.content?.trim()) continue;

    const roleLabel = owMsg.role === "assistant" ? "[assistant]" : "[user]";
    lines.push(`${roleLabel} ${owMsg.content.trim()}`);

    // Extract RAG citations if present (OpenWebUI RAG plugin adds citations array)
    if (Array.isArray(owMsg.citations) && owMsg.citations.length > 0) {
      for (const citation of owMsg.citations) {
        const citText =
          typeof citation === "string"
            ? citation
            : citation?.document
              ? String(citation.document).slice(0, 500)
              : JSON.stringify(citation).slice(0, 500);
        if (citText.trim()) {
          lines.push(`[citation] ${citText.trim()}`);
        }
      }
    }
  }

  const full = lines.join("\n");
  if (full.length <= MAX_EVIDENCE_CHARS) return full;

  // Truncate from middle — keep start (context) and end (resolution) most relevant
  const half = Math.floor(MAX_EVIDENCE_CHARS / 2);
  return (
    full.slice(0, half) +
    "\n...[truncated]...\n" +
    full.slice(full.length - half)
  );
}

/**
 * System prompt and evidence extraction for the KB summarizer.
 *
 * Evidence = tool_call parts (grounding) + assistant text.
 * User messages are excluded — they introduce noise and PII risk.
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
- tags: include hostnames, service names, error codes found in tool outputs.
- All text fields: plain text only, no markdown.
- Respond with ONLY the JSON object, no preamble.`;

/** Max characters of evidence to send (approx 8K tokens at ~4 chars/token). */
const MAX_EVIDENCE_CHARS = 32_000;

export interface MessagePart {
  kind: "text" | "tool";
  text?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
}

export interface RawMessage {
  role: string;
  content: string;
  parts?: unknown;
}

/**
 * Build evidence string from messages:
 * - assistant text parts (final answers / reasoning)
 * - tool_call + tool_result pairs (grounding — most important)
 *
 * User messages are excluded (they frame the question, rarely contain solution evidence).
 */
export function buildEvidence(messages: RawMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    const parts = Array.isArray(msg.parts) ? (msg.parts as MessagePart[]) : null;

    if (msg.role === "user" && !parts) {
      // Include plain user messages for context (no tool parts)
      lines.push(`[user] ${msg.content}`);
      continue;
    }

    if (!parts) continue;

    for (const part of parts) {
      if (part.kind === "text" && part.text?.trim()) {
        lines.push(`[${msg.role}] ${part.text.trim()}`);
      } else if (part.kind === "tool") {
        lines.push(`[tool:${part.name ?? "unknown"}] input=${JSON.stringify(part.input ?? {})}`);
        if (part.output !== undefined) {
          const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
          // Truncate individual tool output to 2000 chars to avoid one tool dominating
          lines.push(`[tool_result] ${out.slice(0, 2000)}`);
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

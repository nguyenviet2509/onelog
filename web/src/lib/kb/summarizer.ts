/**
 * KB summarizer — calls DeepSeek (OpenAI-compat) to extract a draft KB entry
 * from a conversation's messages+parts evidence.
 *
 * Env vars:
 *   DEEPSEEK_API_KEY      — required for real mode
 *   KB_SUMMARIZE_MODEL    — default deepseek-chat
 *   KB_LLM_MOCK           — "true" → return fixed mock draft, skip API call
 *
 * Validates LLM JSON output with zod; retries once on parse failure.
 * Returns DraftEntry — no DB writes happen here.
 */

import { z } from "zod";
import { buildEvidence, SYSTEM_PROMPT, type RawMessage } from "./summarizer-prompt";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const DraftEntrySchema = z.object({
  title: z.string().min(1).max(200),
  symptom: z.string().min(1),
  root_cause: z.string().min(1),
  fix: z.string().min(1),
  department: z.enum(["SRE", "DBA", "NetOps", "AppDev", "Security"]).optional(),
  topic: z.string().max(64).optional(),
  issue_type: z.string().max(64).optional(),
  tags: z.array(z.string()).default([]),
});

export type DraftEntry = z.infer<typeof DraftEntrySchema>;

// ---------------------------------------------------------------------------
// Mock mode
// ---------------------------------------------------------------------------

function isMockMode(): boolean {
  return process.env.KB_LLM_MOCK === "true" || !process.env.DEEPSEEK_API_KEY;
}

const MOCK_DRAFT: DraftEntry = {
  title: "[MOCK] Disk full on /var/log — rsyslog stopped",
  symptom: "rsyslog service stopped writing logs; disk usage at 100% on /var/log partition",
  root_cause: "Log rotation misconfigured; old logs not pruned; /var/log filled in 48h",
  fix: "1. Remove old .gz logs older than 30d\n2. Set compress + dateext in /etc/logrotate.d/rsyslog\n3. Restart rsyslog",
  department: "SRE",
  topic: "rsyslog",
  issue_type: "disk-full",
  tags: ["rsyslog", "disk", "logrotate"],
};

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callLLM(evidence: string): Promise<string> {
  const model = process.env.KB_SUMMARIZE_MODEL ?? "deepseek-chat";
  const apiKey = process.env.DEEPSEEK_API_KEY!;

  const messages: OpenAIMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Extract a KB entry from this conversation:\n\n${evidence}`,
    },
  ];

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned empty content");
  return content;
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

function parseAndValidate(raw: string): DraftEntry {
  // Strip markdown code fence if model wraps response despite json_object mode
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed: unknown = JSON.parse(cleaned);
  return DraftEntrySchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize a conversation's messages into a draft KB entry.
 * Retries once on JSON parse failure (different prompt emphasis).
 *
 * @param messages  Raw message rows from DB (role + content + parts)
 * @throws          If both LLM attempt and retry fail, or zod validation fails after retry
 */
export async function summarizeConversation(messages: RawMessage[]): Promise<DraftEntry> {
  if (isMockMode()) {
    return MOCK_DRAFT;
  }

  const evidence = buildEvidence(messages);
  if (!evidence.trim()) {
    throw new Error("No evidence found in conversation to summarize");
  }

  // First attempt
  let raw: string;
  try {
    raw = await callLLM(evidence);
    return parseAndValidate(raw);
  } catch (firstErr) {
    // Retry once — zod/parse failure most common cause
    console.warn("kb.summarizer.retry", { reason: (firstErr as Error).message });
  }

  // Second attempt — slightly stricter prompt emphasis
  try {
    raw = await callLLM(
      evidence +
        "\n\n[IMPORTANT: Respond ONLY with valid JSON matching the schema. No extra text.]",
    );
    return parseAndValidate(raw);
  } catch (retryErr) {
    throw new Error(
      `Summarizer failed after retry: ${(retryErr as Error).message}`,
    );
  }
}

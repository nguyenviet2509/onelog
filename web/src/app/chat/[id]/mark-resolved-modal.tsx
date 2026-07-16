"use client";

/**
 * MarkResolvedModal — review/edit KB draft before saving.
 *
 * Flow:
 *   1. On open: POST /api/kb/summarize → receive draft
 *   2. Member edits fields inline
 *   3. Submit: POST /api/kb/entries
 *   4. If 409 dedupHits → show merge dialog (force / cancel)
 *   5. On success → toast with entry id
 */

import { useState } from "react";
import type { SummarizeResponse } from "@/app/api/kb/summarize/route";
import type { EntriesSuccessResponse, EntryDedupResponse } from "@/app/api/kb/entries/route";

interface Props {
  conversationId: string;
  onClose: () => void;
}

type Step = "idle" | "loading" | "review" | "submitting" | "dedup" | "done" | "error";

interface DraftForm {
  title: string;
  symptom: string;
  root_cause: string;
  fix: string;
  department: string;
  topic: string;
  issue_type: string;
  tags: string; // comma-separated for easy editing
}

interface DedupHit {
  id: string;
  title: string;
  score: number;
}

export function MarkResolvedModal({ conversationId, onClose }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [form, setForm] = useState<DraftForm>({
    title: "", symptom: "", root_cause: "", fix: "",
    department: "", topic: "", issue_type: "", tags: "",
  });
  const [dedupHits, setDedupHits] = useState<DedupHit[]>([]);
  const [savedId, setSavedId] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");

  // Step 1: fetch draft from summarize API
  async function fetchDraft() {
    setStep("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/kb/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as SummarizeResponse;
      const d = data.draft;
      setForm({
        title: d.title,
        symptom: d.symptom,
        root_cause: d.root_cause,
        fix: d.fix,
        department: d.department ?? "",
        topic: d.topic ?? "",
        issue_type: d.issue_type ?? "",
        tags: (d.tags ?? []).join(", "),
      });
      setStep("review");
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStep("error");
    }
  }

  // Step 2: submit entry (with optional force flag)
  async function submitEntry(force = false) {
    setStep("submitting");
    setErrorMsg("");
    try {
      const entry = {
        conversationId,
        title: form.title.trim(),
        symptom: form.symptom.trim(),
        root_cause: form.root_cause.trim(),
        fix: form.fix.trim(),
        department: form.department.trim() || undefined,
        topic: form.topic.trim() || undefined,
        issue_type: form.issue_type.trim() || undefined,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
      };

      const res = await fetch("/api/kb/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, force }),
      });

      if (res.status === 409) {
        // Dedup hits — ask member to decide
        const data = (await res.json()) as EntryDedupResponse;
        setDedupHits(data.dedupHits ?? []);
        setStep("dedup");
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as EntriesSuccessResponse;
      setSavedId(data.id);
      setStep("done");
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStep("error");
    }
  }

  function field(key: keyof DraftForm, label: string, multiline = false) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-muted">{label}</label>
        {multiline ? (
          <textarea
            value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            rows={3}
            className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent resize-y"
          />
        ) : (
          <input
            value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            className="rounded border border-border bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-surface p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg">Mark as Resolved — Save to KB</h2>
          <button
            onClick={onClose}
            className="text-muted hover:text-fg text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Idle */}
        {step === "idle" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <p className="text-sm text-muted max-w-sm">
              AI sẽ extract symptom, root cause và fix từ conversation này và
              tạo một KB entry để team tham khảo sau.
            </p>
            <button
              onClick={fetchDraft}
              className="rounded-lg bg-accent px-6 py-2 text-sm font-medium text-bg"
            >
              Generate Draft
            </button>
          </div>
        )}

        {/* Loading */}
        {step === "loading" && (
          <div className="flex items-center justify-center py-12 text-muted text-sm">
            Đang phân tích conversation… (có thể mất 5-10s)
          </div>
        )}

        {/* Review form */}
        {step === "review" && (
          <div className="flex flex-col gap-3">
            {field("title", "Title")}
            {field("symptom", "Symptom", true)}
            {field("root_cause", "Root Cause", true)}
            {field("fix", "Fix", true)}
            <div className="grid grid-cols-3 gap-3">
              {field("department", "Department")}
              {field("topic", "Topic")}
              {field("issue_type", "Issue Type")}
            </div>
            {field("tags", "Tags (comma-separated)")}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                onClick={() => submitEntry(false)}
                disabled={!form.title.trim() || !form.symptom.trim()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
              >
                Save to KB
              </button>
            </div>
          </div>
        )}

        {/* Submitting */}
        {step === "submitting" && (
          <div className="flex items-center justify-center py-12 text-muted text-sm">
            Đang lưu vào KB…
          </div>
        )}

        {/* Dedup dialog */}
        {step === "dedup" && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fg">
              Tìm thấy {dedupHits.length} entry tương tự trong KB:
            </p>
            <ul className="flex flex-col gap-2">
              {dedupHits.map((hit) => (
                <li
                  key={hit.id}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm"
                >
                  <span className="font-medium text-fg">{hit.title}</span>
                  <span className="ml-2 text-xs text-muted">
                    similarity {(hit.score * 100).toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              Bạn muốn tạo entry mới (duplicate) hay hủy?
            </p>
            {/* TODO Phase 2: add "Upvote existing" button once POST /api/kb/:id/upvote ships */}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg"
              >
                Cancel
              </button>
              <button
                onClick={() => { setStep("review"); setDedupHits([]); }}
                className="rounded-lg border border-border px-4 py-2 text-sm text-fg hover:bg-surface"
              >
                Edit Draft
              </button>
              <button
                onClick={() => submitEntry(true)}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white"
              >
                Force Create Anyway
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <p className="text-sm font-medium text-fg">
              KB entry saved successfully!
            </p>
            <p className="font-mono text-xs text-muted">{savedId}</p>
            <button
              onClick={onClose}
              className="rounded-lg bg-accent px-6 py-2 text-sm font-medium text-bg"
            >
              Close
            </button>
          </div>
        )}

        {/* Error */}
        {step === "error" && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <p className="text-sm text-red-500">{errorMsg}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setStep("idle")}
                className="rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-fg"
              >
                Retry
              </button>
              <button
                onClick={onClose}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

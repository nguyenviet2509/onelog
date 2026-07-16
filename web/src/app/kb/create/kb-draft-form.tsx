"use client";

/**
 * KbDraftForm — client component for reviewing + submitting a KB draft.
 *
 * Props come from the server component (page.tsx) which verified the draft.
 * Submits to POST /api/kb/entries with draftId + accessToken.
 *
 * Dedup response (409) shows inline dialog:
 *   - Force Create: resubmit with force=true
 *   - Cancel: stay on form
 *
 * No OpenWebUI JWT required — access_token is the auth mechanism here.
 */

import { useState, useTransition, useEffect } from "react";
import type { DraftEntry } from "@/lib/kb/summarizer";
import type { DedupHit } from "@/lib/kb/dedup";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KbDraftFormProps {
  draft: DraftEntry;
  draftId: string;
  accessToken: string;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; entryId: string }
  | { kind: "dedup"; hits: DedupHit[] }
  | { kind: "error"; message: string };

const DEPARTMENTS = ["SRE", "DBA", "NetOps", "AppDev", "Security"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tagsToString(tags: string[]): string {
  return tags.join(", ");
}

function stringToTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KbDraftForm({ draft, draftId, accessToken }: KbDraftFormProps) {
  const [fields, setFields] = useState<DraftEntry>({ ...draft });
  const [tagsInput, setTagsInput] = useState(tagsToString(draft.tags));
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  // M2: Strip `token` from browser URL after load so it doesn't persist in
  // browser history or leak via Referer. The token is already consumed by the
  // server component; we only need draftId in the URL for UX (page reload will
  // show the expired/missing-token error, which is correct behaviour).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("token")) {
      url.searchParams.delete("token");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  function setField<K extends keyof DraftEntry>(key: K, value: DraftEntry[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function submitEntry(force = false) {
    setState({ kind: "submitting" });

    const payload = {
      draftId,
      accessToken,
      edits: {
        ...fields,
        tags: stringToTags(tagsInput),
      },
      force,
    };

    try {
      const res = await fetch("/api/kb/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 201) {
        const data = (await res.json()) as { id: string };
        setState({ kind: "success", entryId: data.id });
        return;
      }

      if (res.status === 409) {
        const data = (await res.json()) as { dedupHits: DedupHit[] };
        setState({ kind: "dedup", hits: data.dedupHits });
        return;
      }

      const data = (await res.json()) as { error?: string };
      setState({
        kind: "error",
        message: data.error ?? `Unexpected error (${res.status})`,
      });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(() => {
      void submitEntry(false);
    });
  }

  // --- Success ---
  if (state.kind === "success") {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6">
        <h2 className="text-lg font-semibold text-green-800 mb-2">Entry Saved</h2>
        <p className="text-green-700 text-sm">
          KB entry <code className="font-mono text-xs">{state.entryId}</code> has been
          created successfully. You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Title */}
      <FormField label="Title" required>
        <input
          type="text"
          value={fields.title}
          onChange={(e) => setField("title", e.target.value)}
          maxLength={200}
          required
          className={inputCls}
        />
      </FormField>

      {/* Department */}
      <FormField label="Department">
        <select
          value={fields.department ?? ""}
          onChange={(e) =>
            setField(
              "department",
              (e.target.value as DraftEntry["department"]) || undefined,
            )
          }
          className={inputCls}
        >
          <option value="">— select —</option>
          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </FormField>

      {/* Topic */}
      <FormField label="Topic">
        <input
          type="text"
          value={fields.topic ?? ""}
          onChange={(e) => setField("topic", e.target.value || undefined)}
          maxLength={64}
          placeholder="e.g. rsyslog, mysql, disk"
          className={inputCls}
        />
      </FormField>

      {/* Issue Type */}
      <FormField label="Issue Type">
        <input
          type="text"
          value={fields.issue_type ?? ""}
          onChange={(e) => setField("issue_type", e.target.value || undefined)}
          maxLength={64}
          placeholder="e.g. disk-full, oom, crash-loop"
          className={inputCls}
        />
      </FormField>

      {/* Tags */}
      <FormField label="Tags" hint="Comma-separated">
        <input
          type="text"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="rsyslog, disk, logrotate"
          className={inputCls}
        />
      </FormField>

      {/* Symptom */}
      <FormField label="Symptom" required>
        <textarea
          value={fields.symptom}
          onChange={(e) => setField("symptom", e.target.value)}
          required
          rows={3}
          className={inputCls}
        />
      </FormField>

      {/* Root Cause */}
      <FormField label="Root Cause" required>
        <textarea
          value={fields.root_cause}
          onChange={(e) => setField("root_cause", e.target.value)}
          required
          rows={3}
          className={inputCls}
        />
      </FormField>

      {/* Fix */}
      <FormField label="Fix / Remediation" required>
        <textarea
          value={fields.fix}
          onChange={(e) => setField("fix", e.target.value)}
          required
          rows={4}
          className={inputCls}
        />
      </FormField>

      {/* Error */}
      {state.kind === "error" && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.message}
        </div>
      )}

      {/* Dedup dialog */}
      {state.kind === "dedup" && (
        <DedupDialog
          hits={state.hits}
          onForce={() => startTransition(() => { void submitEntry(true); })}
          onCancel={() => setState({ kind: "idle" })}
        />
      )}

      {/* Submit */}
      {state.kind !== "dedup" && (
        <button
          type="submit"
          disabled={isPending || state.kind === "submitting"}
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-white font-medium
                     hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed
                     transition-colors"
        >
          {state.kind === "submitting" ? "Saving…" : "Save to Knowledge Base"}
        </button>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm " +
  "focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

function FormField({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
        {hint && <span className="ml-1 text-gray-400 font-normal">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function DedupDialog({
  hits,
  onForce,
  onCancel,
}: {
  hits: DedupHit[];
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
      <h3 className="font-semibold text-amber-800">Similar Entry Found</h3>
      <p className="text-sm text-amber-700">
        The following existing entries are very similar (similarity ≥ 90%). Creating a
        duplicate may reduce knowledge base quality.
      </p>
      <ul className="space-y-1">
        {hits.map((h) => (
          <li key={h.id} className="text-sm text-amber-900">
            <span className="font-mono text-xs text-amber-600 mr-2">
              {(h.score * 100).toFixed(0)}%
            </span>
            {h.title}
          </li>
        ))}
      </ul>
      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onForce}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm text-white
                     hover:bg-amber-700 transition-colors"
        >
          Force Create Anyway
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm
                     text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * /kb/create?draft=<draftId>&token=<accessToken>
 *
 * Server component — loads draft from Postgres via getDraftByToken().
 * Renders <KbDraftForm> client component with draft data pre-filled.
 *
 * Auth: access_token in URL query param (32-byte hex, stored in kb_drafts row).
 * No OpenWebUI JWT required here — token issued at summarize time is sufficient.
 *
 * Error states:
 *   - Missing params          → 400-style error message
 *   - Draft not found/expired → "Draft expired" notice with retry instructions
 */

import type { Metadata } from "next";
import { getDraftByToken } from "@/lib/kb/draft-store";
import { ensureBootstrap } from "@/db/bootstrap";
import KbDraftForm from "./kb-draft-form";

interface PageProps {
  searchParams: Promise<{ draft?: string; token?: string }>;
}

export const dynamic = "force-dynamic";

/**
 * Suppress Referer header on this page — the URL contains an access_token
 * query param that must not leak to third-party resources via Referer.
 * Note: nginx/proxy access logs still record the full URL with token.
 * Nginx deployment should apply log_format filtering for /kb/create.
 */
export const metadata: Metadata = {
  other: { referrer: "no-referrer" },
};

export default async function KbCreatePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const draftId = params.draft;
  const accessToken = params.token;

  // --- Validate query params ---
  if (!draftId || !accessToken) {
    return (
      <main className="max-w-2xl mx-auto py-16 px-4">
        <h1 className="text-xl font-semibold text-red-600 mb-2">Invalid Link</h1>
        <p className="text-gray-600">
          This KB review link is missing required parameters. Please use the link
          provided by the &ldquo;Mark Resolved&rdquo; action in OpenWebUI.
        </p>
      </main>
    );
  }

  // --- Load draft ---
  await ensureBootstrap();

  let draftRecord;
  try {
    draftRecord = await getDraftByToken(draftId, accessToken);
  } catch (err) {
    console.error("kb.create.load_draft_failed", err);
    return (
      <main className="max-w-2xl mx-auto py-16 px-4">
        <h1 className="text-xl font-semibold text-red-600 mb-2">Service Error</h1>
        <p className="text-gray-600">
          Could not load draft. Please try again later.
        </p>
      </main>
    );
  }

  if (!draftRecord) {
    // Draft expired or token mismatch — show actionable message
    return (
      <main className="max-w-2xl mx-auto py-16 px-4">
        <h1 className="text-xl font-semibold text-amber-600 mb-2">Draft Expired</h1>
        <p className="text-gray-600 mb-4">
          This KB draft has expired (drafts are valid for 30 minutes) or the link
          is invalid.
        </p>
        <p className="text-gray-600">
          To create a new draft, click &ldquo;Mark Resolved&rdquo; in the OpenWebUI
          message toolbar again.
        </p>
      </main>
    );
  }

  // draft found and valid — render editable form
  return (
    <main className="max-w-2xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-bold mb-1">Review KB Draft</h1>
      <p className="text-gray-500 text-sm mb-6">
        Review and edit the extracted knowledge base entry before saving.
        Fields are pre-filled from the conversation summary.
      </p>
      <KbDraftForm
        draft={draftRecord.draft}
        draftId={draftRecord.id}
        accessToken={draftRecord.accessToken}
      />
    </main>
  );
}

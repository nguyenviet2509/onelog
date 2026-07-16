"use client";

/**
 * MarkResolvedButton — client island for the "Mark Resolved" trigger.
 *
 * Rendered inside the server-component chat page header. Keeps the modal
 * state fully client-side; the server page stays a pure server component.
 */

import { useState } from "react";
import { MarkResolvedModal } from "./mark-resolved-modal";

interface Props {
  conversationId: string;
}

export function MarkResolvedButton({ conversationId }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-accent hover:text-accent transition-colors"
        title="Extract KB entry from this conversation"
      >
        ✓ Mark Resolved
      </button>

      {open && (
        <MarkResolvedModal
          conversationId={conversationId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

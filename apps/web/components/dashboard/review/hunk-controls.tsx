"use client";

import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui/icons";
import type { HunkDecision } from "@/lib/refresh/types";

// ---------------------------------------------------------------------------
// The controls a hunk review shares, wherever it is shown
// ---------------------------------------------------------------------------
//
// Two places review hunks: the Improvements execution page and the editor's
// rewrite panel. The counter, the Keep/Reject pair and the Keep all/Reject all
// pair are the same in both, so they live here and neither caller carries its
// own copy. Layout around them differs and stays local.
//
// Hunk HTML (model output, a reviewer's edit, or a block read from the live
// page) is rendered as HTML so the reviewer sees the page, not the markup.
// Both callers pass it through `sanitizeHtml` (lib/html/sanitize.ts), the
// allowlist sanitiser every other article HTML sink uses, first.

/** "N / M kept": the one number a review is about. */
export function KeptCounter({ kept, total, className }: { kept: number; total: number; className?: string }) {
  return (
    <span className={className ?? "font-mono tabular-nums font-medium"} aria-live="polite">
      {kept} / {total} kept
    </span>
  );
}

export function DecideAllButtons({
  onDecideAll,
  disabled,
}: {
  onDecideAll: (d: HunkDecision) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onDecideAll("accepted")} disabled={disabled}>
        Keep all
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onDecideAll("rejected")} disabled={disabled}>
        Reject all
      </Button>
    </>
  );
}

export function KeepRejectButtons({
  decision,
  onDecide,
  labels = true,
}: {
  decision?: HunkDecision;
  onDecide: (d: HunkDecision) => void;
  /** Icon-only when false, for narrow layouts. */
  labels?: boolean;
}) {
  return (
    <>
      <Button
        size="sm"
        variant={decision === "accepted" ? "primary" : "ghost"}
        onClick={() => onDecide("accepted")}
        aria-label={labels ? undefined : "Keep"}
        aria-pressed={decision === "accepted"}
      >
        <Icons.check size={12} /> {labels && "Keep"}
      </Button>
      <Button
        size="sm"
        variant={decision === "rejected" ? "primary" : "ghost"}
        onClick={() => onDecide("rejected")}
        aria-label={labels ? undefined : "Reject"}
        aria-pressed={decision === "rejected"}
      >
        <Icons.x size={12} /> {labels && "Reject"}
      </Button>
    </>
  );
}

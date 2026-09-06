"use client";

import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui/icons";
import type { HunkDecision } from "@/lib/refresh/types";

// ---------------------------------------------------------------------------
// The controls a hunk review shares, wherever it is shown
// ---------------------------------------------------------------------------
//
// Two places review hunks: the Improvements execution page and the editor's
// rewrite panel. The counter, the Keep/Reject pair, the Keep all/Reject all
// pair and the sanitiser are the same in both, so they live here and neither
// caller carries its own copy. Layout around them differs and stays local.

/**
 * Model output is rendered as HTML so the reviewer sees the page, not the
 * markup. It is also model output, so anything executable is stripped first:
 * scripts, inline handlers, javascript: URLs, and embeds.
 */
export function sanitizeHunkHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

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

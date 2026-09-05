"use client";

import { cn } from "@/lib/utils";
import { KeepRejectButtons, sanitizeHunkHtml } from "@/components/dashboard/review/hunk-controls";
import type { Hunk, HunkDecision } from "@/lib/refresh/types";

// ---------------------------------------------------------------------------
// The proposed article, block by block, as the kept decisions would apply it
// ---------------------------------------------------------------------------
//
// Not a two-column diff: the panel is narrow and a reviewer of prose wants to
// read the article as it will be, then object. So each hunk shows the block
// the current decisions produce (the rewrite when kept, the original when
// rejected) with a chip that says which it is, and a toggle for the other
// side. Unchanged blocks are printed dim so the changed ones read in context.
// Blocks are model output and go through the same sanitiser the Improvements
// review uses before they are rendered. Nothing here writes: the parent
// applies the decisions.

export const HUNK_CHIP: Record<Exclude<Hunk["kind"], "unchanged">, string> = {
  changed: "REWRITTEN",
  added: "ADDED",
  removed: "REMOVED",
};

const PROSE =
  "prose-block text-[12.5px] leading-[1.55] [&_h2]:mt-1 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_a]:text-accent-ink [&_a]:underline [&_img]:my-1.5 [&_img]:max-h-32 [&_img]:rounded-[6px] [&_strong]:font-semibold [&_em]:italic";

function Block({ html, className }: { html: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: sanitizeHunkHtml(html) }} />;
}

export function RewriteHunkList({
  hunks,
  decisions,
  focusedId,
  compareId,
  onDecide,
  onFocus,
  onCompare,
}: {
  hunks: readonly Hunk[];
  decisions: Record<string, HunkDecision>;
  /** The hunk the ∧ ∨ navigation is on. */
  focusedId: string | null;
  /** The hunk whose other side is open. */
  compareId: string | null;
  onDecide: (id: string, d: HunkDecision) => void;
  onFocus: (id: string) => void;
  onCompare: (id: string | null) => void;
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Proposed article, block by block">
      {hunks.map((h) => {
        if (h.kind === "unchanged") {
          return (
            <li key={h.id} className={cn("px-2 py-1 text-ink-3", PROSE)}>
              <Block html={h.before ?? ""} />
            </li>
          );
        }
        const kept = decisions[h.id] === "accepted";
        // What Apply would put in the document for this block.
        const shown = h.kind === "removed" ? h.before : kept ? h.after : h.before;
        const other = h.kind === "removed" ? null : kept ? h.before : h.after;
        const focused = focusedId === h.id;
        const comparing = compareId === h.id;
        return (
          <li
            key={h.id}
            data-hunk-id={h.id}
            tabIndex={-1}
            onClick={() => onFocus(h.id)}
            className={cn(
              "rounded-[8px] border border-l-[3px] border-line bg-bg",
              kept ? "border-l-accent" : "border-l-line",
              focused && "ring-1 ring-accent",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line-soft px-2 py-1 text-[10.5px]">
              <span
                className={cn(
                  "rounded-[4px] px-1.5 py-0.5 font-mono uppercase tracking-[0.06em]",
                  kept ? "bg-accent-soft text-accent-ink" : "bg-panel-2 text-ink-3",
                )}
              >
                {HUNK_CHIP[h.kind]}
              </span>
              <span className={kept ? "text-ok-ink" : "text-ink-3"}>{kept ? "kept" : "rejected"}</span>
              <div className="ml-auto flex gap-0.5">
                <KeepRejectButtons decision={decisions[h.id]} onDecide={(d) => onDecide(h.id, d)} labels={false} />
              </div>
            </div>
            <div
              className={cn(
                "px-2 py-1.5",
                PROSE,
                h.kind === "removed" && kept && "line-through opacity-60",
              )}
            >
              {h.kind === "added" && !kept ? (
                <p className="my-1 italic text-ink-3">This block would be added. Rejected, so it stays out.</p>
              ) : (
                <Block html={shown ?? ""} />
              )}
            </div>
            {other && (
              <div className="border-t border-line-soft px-2 py-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCompare(comparing ? null : h.id);
                  }}
                  className="text-[11px] text-accent-ink hover:underline"
                >
                  {comparing ? "Hide" : kept ? "Show the original" : "Show the rewrite"}
                </button>
                {comparing && <Block html={other} className={cn("mt-1 rounded-[6px] bg-panel-2 px-2 py-1 text-ink-2", PROSE)} />}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { pauseWorkspace, resumeWorkspace } from "@/app/actions/workspaces";
import type { PausedMeta } from "@/lib/types";

function sinceLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * The state a paused site is in, said once, with the way out beside it.
 *
 * Nothing here deletes or changes anything: pausing keeps drafts, plan and
 * pace exactly as they were, and the copy says so because "paused" on its own
 * leaves people wondering what they have lost.
 */
export function PausedBanner({
  workspaceId,
  meta,
  className = "",
}: {
  workspaceId: string;
  meta: PausedMeta | null | undefined;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const since = sinceLabel(meta?.since);

  function resume() {
    start(async () => {
      try {
        const r = await resumeWorkspace(workspaceId);
        toast.success(
          r.replanned === null
            ? "Resumed. The calendar could not be re-planned; it will fill in on the next run."
            : `Resumed. ${r.replanned} planned from today.`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not resume");
      }
    });
  }

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-line bg-panel px-4 py-2.5 text-[12.5px] text-ink-2 ${className}`}
    >
      <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Paused</span>
      <span>
        {since ? `Paused since ${since}. ` : "Paused. "}
        Nothing is written or published. Your plan and drafts are kept.
      </span>
      <Button size="sm" variant="primary" className="ml-auto" onClick={resume} disabled={pending}>
        {pending ? "Resuming…" : "Resume"}
      </Button>
    </div>
  );
}

/**
 * Pause or resume a site from wherever its status is shown. Text, not an icon:
 * the action is rare and the word is the explanation.
 */
export function PauseSiteControl({
  workspaceId,
  name,
  status,
  className = "",
  asButton = false,
}: {
  workspaceId: string;
  name: string;
  status: string;
  className?: string;
  /** Render as a Button (page header) rather than a text link (sidebar). */
  asButton?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const paused = status === "paused";
  // A site still in setup has nothing running to pause; the wizard is the
  // thing to finish or skip.
  if (!paused && status === "setup") return null;

  function toggle() {
    if (!paused) {
      const ok = window.confirm(
        `Pause ${name}? Nothing will be written or published for it until you resume. Drafts, keywords and the plan are kept.`,
      );
      if (!ok) return;
    }
    start(async () => {
      try {
        if (paused) {
          const r = await resumeWorkspace(workspaceId);
          toast.success(r.replanned === null ? "Resumed" : `Resumed. ${r.replanned} planned from today.`);
        } else {
          await pauseWorkspace(workspaceId);
          toast.success(`${name} is paused. Nothing is written or published; your plan and drafts are kept.`);
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change the site's status");
      }
    });
  }

  const label = pending ? (paused ? "Resuming…" : "Pausing…") : paused ? "Resume" : "Pause this site";

  if (asButton) {
    return (
      <Button size="sm" variant={paused ? "primary" : "default"} onClick={toggle} disabled={pending} className={className}>
        {label}
      </Button>
    );
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      className={`text-[11px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink disabled:opacity-60 cursor-pointer ${className}`}
    >
      {label}
    </button>
  );
}

"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { pauseWorkspace, resumeWorkspace } from "@/app/actions/workspaces";
import type { PausedMeta } from "@/lib/types";
import { formatPauseDate } from "@/lib/billing/pause";

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
  pausedUntil = null,
  className = "",
}: {
  workspaceId: string;
  meta: PausedMeta | null | undefined;
  /**
   * Set when the site is paused by the account pause on Billing. That pause
   * is lifted on Billing, for every site and for billing together; a Resume
   * here used to lift it for one site while Stripe kept voiding invoices.
   */
  pausedUntil?: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const since = sinceLabel(meta?.since);

  if (pausedUntil) {
    return (
      <div
        role="status"
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[8px] border border-line bg-panel px-4 py-2.5 text-[12.5px] text-ink-2 ${className}`}
      >
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Paused</span>
        <span>
          The whole account is paused until {formatPauseDate(pausedUntil)}. Nothing is drafted or billed until then. Your
          plan and drafts are kept.
        </span>
        <Link href="/settings/billing" className="ml-auto">
          <Button size="sm" variant="primary">Open Billing</Button>
        </Link>
      </div>
    );
  }

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
 * Pause or resume a workspace from wherever its status is shown. Text, not an
 * icon: the action is rare and the word is the explanation.
 *
 * Lives on /workspaces - the roster row and the detail header - since
 * 2026-09-07. It used to also hang under the sidebar's workspace switcher,
 * which put a stop button on every screen in the app for an action taken once
 * in a while.
 */
export function PauseSiteControl({
  workspaceId,
  name,
  status,
  pausedUntil = null,
  className = "",
  asButton = false,
}: {
  workspaceId: string;
  name: string;
  status: string;
  /** Set when the account pause on Billing paused it: lifted there, not here. */
  pausedUntil?: string | null;
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
  // Paused with the account: the way out is Billing, for every site at once.
  if (paused && pausedUntil) {
    return asButton ? (
      <Link href="/settings/billing" onClick={(e) => e.stopPropagation()} className={className}>
        <Button size="sm">Account paused · Billing</Button>
      </Link>
    ) : (
      <Link
        href="/settings/billing"
        onClick={(e) => e.stopPropagation()}
        title={`The whole account is paused until ${formatPauseDate(pausedUntil)}`}
        className={`text-[11px] text-ink-3 underline decoration-line underline-offset-[3px] hover:text-ink ${className}`}
      >
        Account paused
      </Link>
    );
  }

  // The event matters: on /workspaces this button sits inside a row that
  // navigates to the workspace on click (client-row.tsx), and pausing must not
  // also open the page you were pausing from.
  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
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
        toast.error(err instanceof Error ? err.message : "Could not change the workspace's status");
      }
    });
  }

  // "workspace", not "site": POSITIONING.md settled the noun on 2026-08-30 and
  // the surface this control now lives on says workspace everywhere else.
  const label = pending ? (paused ? "Resuming…" : "Pausing…") : paused ? "Resume" : "Pause this workspace";

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

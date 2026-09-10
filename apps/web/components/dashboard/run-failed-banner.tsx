"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Icons } from "@/components/ui";
import type { FailedRunNotice } from "@/lib/onboarding/events";

/**
 * Pinned above the app while the workspace's last setup run fell short.
 *
 * Modelled on the payment-failed bar for the same reason: a state the person
 * has to act on has to say so where they are, not on a screen they already
 * left. The run screen reported "partial" for twenty-five seconds; then the
 * person landed on a dashboard of dashes, with the reason gone and nothing to
 * press. This carries the run's own sentence (`failedRunNotice`, the same one
 * the run screen prints) and the one thing that helps: try again, now, with
 * one click - which starts a fresh run and takes them to the screen that
 * shows it happening.
 *
 * Dismissable, per run: a person who has added keywords by hand and moved on
 * should not be nagged, but a *new* failed run is news again. Remembered in
 * this browser only; it is a convenience, not state.
 */
export function RunFailedBanner({
  workspaceId,
  siteLabel,
  notice,
}: {
  workspaceId: string;
  siteLabel: string;
  notice: FailedRunNotice;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dismissed, setDismissed] = useState(false);
  const storageKey = `altorank.run-failed.dismissed:${notice.runId}`;

  // Read after mount: the server renders the banner, and a hidden-by-storage
  // banner must not flash, but `localStorage` does not exist on the server
  // and can throw in a private window.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey)) setDismissed(true);
    } catch {
      /* no storage: the banner simply shows */
    }
  }, [storageKey]);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(storageKey, new Date().toISOString());
    } catch {
      /* fine */
    }
  }

  function retry() {
    start(async () => {
      try {
        const res = await fetch("/api/onboard/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          toast.error(body?.error ?? `Could not start setup again (${res.status}).`);
          return;
        }
        // The run is its own invocations from here; the run screen polls it
        // and says what happens, phase by phase.
        router.push("/onboarding");
      } catch {
        toast.error("Could not start setup again. Check the connection and try once more.");
      }
    });
  }

  if (dismissed) return null;

  return (
    <div
      role="status"
      data-testid="run-failed-banner"
      className="flex min-h-10 shrink-0 items-center gap-3 border-b border-warn bg-warn-soft px-4 py-1.5 text-[12.5px] leading-[1.45] text-warn-ink"
    >
      <Icons.alert size={14} className="shrink-0" />
      {/* Wraps to two lines rather than truncating: the reason is the whole
          point of the bar, and #191 made it a full sentence. */}
      <span className="line-clamp-2 min-w-0 flex-1">
        <b className="font-semibold">Setup didn&apos;t finish for {siteLabel}</b> — {notice.line}
      </span>
      <Link
        href="/onboarding"
        className="shrink-0 text-[12px] font-medium text-warn-ink underline-offset-2 hover:underline"
      >
        See details
      </Link>
      <button
        onClick={retry}
        disabled={pending}
        className="shrink-0 rounded-[6px] border border-warn bg-bg px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel disabled:opacity-50"
      >
        {pending ? "Starting…" : "Try again"}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-[6px] p-1 text-warn-ink/70 hover:bg-panel hover:text-ink"
      >
        <Icons.x size={13} />
      </button>
    </div>
  );
}

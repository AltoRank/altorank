"use client";

import Link from "next/link";
import { Button } from "@/components/ui";
import { plural } from "@/lib/utils";
import { trackNextUpClicked } from "@/lib/onboarding/article-events";

/**
 * The one thing on the dashboard that waits on a person: the oldest draft in
 * review. It was said four times on this page (sidebar badge, a stat tile, a
 * recommended-action card and a "Needs your review" card) and none of them
 * was the page's primary button - that was "Add workspace" (UX clarity audit
 * 2026-10-18, #2). Now it is said once, at the top, with the only accent
 * button on the page. A client component only for the click: the funnel's
 * step after an approval (onboarding.step `next_up_clicked`).
 */
export function NextUp({
  draft,
  waiting,
  autoApprove,
  first = false,
}: {
  draft: { id: string; title: string };
  waiting: number;
  /** The workspace's own setting: with it on, a draft does not wait for anyone. */
  autoApprove: boolean;
  /**
   * The trial's first days, with nothing approved yet: the page leads with
   * the one draft and puts everything else under "More tools".
   */
  first?: boolean;
}) {
  const others = waiting - 1;
  const rule = autoApprove
    ? "Auto-approve is on: it goes out on its own once it passes our checks, unless you hold it."
    : "Nothing publishes until you approve it.";
  const more = others > 0 && (
    <>
      {" "}
      <Link href="/articles?status=review" onClick={() => trackNextUpClicked(draft.id, "more")} className="text-ink-2 underline underline-offset-2 hover:text-accent-ink">
        {plural(others, "more draft")} waiting
      </Link>
    </>
  );
  return (
    <section
      aria-label="Next up"
      className="mb-4 flex flex-col gap-4 rounded-[10px] border border-accent/30 bg-accent-soft/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-accent-ink">Next up</div>
        {first ? (
          <>
            <h2 className="m-0 text-[17px] font-semibold leading-snug">Review your first article</h2>
            <p className="m-0 mt-1 text-[14px] leading-snug text-ink [text-wrap:balance]">{draft.title}</p>
          </>
        ) : (
          <h2 className="m-0 text-[17px] font-semibold leading-snug [text-wrap:balance]">
            <span className="text-ink">{draft.title}</span> <span className="font-normal text-ink-2">is ready for your yes</span>
          </h2>
        )}
        <p className="m-0 mt-1 text-[12.5px] text-ink-3">
          {rule}
          {more}
        </p>
      </div>
      <Link href={`/content/${draft.id}`} onClick={() => trackNextUpClicked(draft.id, "draft")} className="shrink-0">
        <Button variant="accent">{first ? "Review draft" : "Read and approve"}</Button>
      </Link>
    </section>
  );
}

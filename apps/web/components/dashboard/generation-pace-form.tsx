"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { setGenerationPace } from "@/app/actions/workspaces";
import { monthlyFromPace } from "@/lib/content/pace";

/**
 * The control behind "at the pace you set per site".
 *
 * That sentence has been on the pricing page while the number it refers to was
 * only ever written by signup and by two internal code paths. This is the
 * setting it was describing.
 *
 * It shows the monthly consequence of the weekly number, because a weekly
 * limit is not what anyone is buying: the plan is sold per month, and the
 * arithmetic between the two (a rolling week, so 52/12 rather than 4) is not
 * something a customer should have to do to find out whether their setting
 * reaches what they paid for.
 */
export function GenerationPaceForm({
  workspaceId,
  current,
  planIncluded,
  maxPace,
}: {
  workspaceId: string;
  current: number | null;
  /** The account's included articles a month, for saying whether this reaches it. */
  planIncluded: number | null;
  /**
   * The highest pace this account's plan allows (lib/plan/pace-options.ts).
   *
   * The slider used to run to MAX_PACE on every tier, and the action behind it
   * wrote whatever arrived: a free account could set 25 a week - about 108 a
   * month against seven drafts - while the calendar's own pace control, one
   * click away, refused the same number with "Needs the Managed plan". The
   * server now enforces the rule; this is the same rule drawn, so the refusal
   * does not arrive after the fact.
   */
  maxPace: number;
}) {
  // A site already set above what the plan now allows (a downgrade) keeps its
  // number on screen rather than snapping down; the slider simply cannot be
  // pushed higher, and Save is refused above the ceiling either way.
  const ceiling = Math.max(maxPace, current ?? 0);
  const [pace, setPace] = useState(current ?? 0);
  const [pending, startTransition] = useTransition();
  const monthly = monthlyFromPace(pace);
  const overPlan = pace > maxPace;

  function save() {
    startTransition(async () => {
      try {
        await setGenerationPace(workspaceId, pace);
        toast.success(
          pace === 0
            ? "Generation paused for this site"
            : `Writing up to ${pace} a week, about ${monthly} a month`,
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not save the pace");
      }
    });
  }

  return (
    <Card className="p-5" flush>
      <h3 className="text-[13px] font-medium mb-1">Writing pace</h3>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">
        How many articles a week the generator may draft for this site. Nothing publishes without
        your approval either way, and your account&rsquo;s monthly quota still applies across all
        your sites.
      </p>

      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={ceiling}
          step={1}
          value={pace}
          onChange={(e) => setPace(Number(e.target.value))}
          aria-label="Articles a week"
          className="flex-1 accent-[var(--accent)]"
        />
        <span className="w-[7.5rem] shrink-0 text-right font-mono text-[12.5px] tabular-nums text-ink-2">
          {pace === 0 ? "paused" : `${pace}/week`}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
        <span>
          {pace === 0
            ? "This site drafts nothing until you raise it."
            : `About ${monthly} articles a month.`}
        </span>
        {/* Only said when there is a plan to compare against, and only as
            arithmetic: a site that cannot reach the included volume on its own
            is not a fault, it is one of several sites sharing the quota. */}
        {pace > 0 && planIncluded !== null && (
          <span className="shrink-0">
            {overPlan
              ? `past the ${planIncluded} your plan includes`
              : monthly >= planIncluded
                ? `reaches your ${planIncluded} included`
                : `your plan includes ${planIncluded}`}
          </span>
        )}
      </div>

      <Button
        variant="accent"
        className="mt-4 w-full justify-center"
        onClick={save}
        disabled={pending || pace === (current ?? 0) || overPlan}
      >
        {pending ? "Saving…" : "Save pace"}
      </Button>

      {overPlan && (
        <p className="mt-2 m-0 text-[12px] leading-relaxed text-ink-3">
          This site is set above what the plan includes. Nothing has been
          changed; lower the pace, or raise the plan on the{" "}
          <a href="/settings/billing" className="text-accent-ink underline decoration-line underline-offset-[3px]">
            Billing page
          </a>
          .
        </p>
      )}
    </Card>
  );
}

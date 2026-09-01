"use client";

import { useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { approveArticle, approveArticles } from "@/app/actions/publish";
import type { Article } from "@/lib/types";

type Verdict = Article["fact_check_verdict"];

export function VerdictPill({ verdict, count }: { verdict: Verdict; count: number | null }) {
  const tone =
    verdict === "clean"
      ? "bg-ok-soft text-ok-ink"
      : verdict === "high_risk"
        ? "bg-err-soft text-err-ink"
        : verdict === "review"
          ? "bg-accent-soft text-accent-ink"
          : "bg-panel text-ink-3";
  const label =
    verdict === "clean"
      ? "Clean"
      : verdict === "high_risk"
        ? "High risk"
        : verdict === "review"
          ? `Check ${count ?? ""}`.trim()
          : "Not checked";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em] ${tone}`}>
      {label}
    </span>
  );
}

/**
 * Two shapes from one component: in the page header it is the batch button,
 * in a row it is that row's approve link. A row with anything but a clean
 * verdict does not get a one-click approve; it gets "Open", because the
 * verdict is telling the reviewer there is something to read first. That is
 * the point of having a verdict.
 */
export function ReviewQueueActions(props: { cleanIds?: string[]; rowId?: string; verdict?: Verdict }) {
  const [pending, start] = useTransition();

  if (props.rowId) {
    const id = props.rowId;
    if (props.verdict !== "clean") {
      return (
        <Link href={`/content/${id}`} className="text-[12px] font-medium text-accent-ink hover:underline">
          Open
        </Link>
      );
    }
    return (
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await approveArticle(id);
              toast.success("Approved. It is ready to publish when you are.");
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not approve");
            }
          })
        }
      >
        {pending ? "Approving…" : "Approve"}
      </Button>
    );
  }

  const ids = props.cleanIds ?? [];
  if (!ids.length) return null;
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            const done = await approveArticles(ids);
            toast.success(
              done.length === ids.length
                ? `Approved ${done.length} clean draft${done.length === 1 ? "" : "s"}`
                : `Approved ${done.length} of ${ids.length}; the rest changed under you`,
            );
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not approve");
          }
        })
      }
    >
      {pending ? "Approving…" : `Approve all ${ids.length} clean`}
    </Button>
  );
}

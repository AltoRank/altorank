"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchBacklinks } from "@/app/actions/seo";
import type { Workspace } from "@/lib/types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Backlinks are checked weekly by the cron. This says when that last happened
 * rather than offering a button that spends a DataForSEO call on every click:
 * the index barely moves day to day, and the button was there because nothing
 * else ran it (2026-09-02). Checking early is still possible once the last
 * check is a week old.
 */
export function BacklinkFreshness({
  workspaces,
  scopedId,
  lastCheckedAt,
}: {
  workspaces: Pick<Workspace, "id" | "name">[];
  scopedId?: string | null;
  lastCheckedAt: string | null;
}) {
  const [pending, start] = useTransition();
  const workspaceId = scopedId ?? workspaces[0]?.id ?? "";
  if (!workspaceId) return null;

  const age = lastCheckedAt ? Date.now() - new Date(lastCheckedAt).getTime() : null;
  const due = age === null || age >= WEEK_MS;
  const when = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <div className="flex items-center gap-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help font-mono text-[11px] text-ink-3">
            {when ? `checked weekly · last ${when}` : "checked weekly"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px]">
          The daily rank job looks up this site&rsquo;s backlinks once a week, which is roughly
          how often the index changes. Each check is one paid lookup, so it is not run on
          every page view.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              disabled={!due || pending}
              onClick={() =>
                start(async () => {
                  try {
                    const r = await fetchBacklinks(workspaceId);
                    toast.success(
                      `${r.fetched} referring domains` +
                        (r.total !== null ? ` of ${r.total.toLocaleString()} links` : "") +
                        (r.lost ? `, ${r.lost} now lost` : ""),
                    );
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not fetch backlinks");
                  }
                })
              }
            >
              {pending ? "Checking…" : "Check now"}
            </Button>
          </span>
        </TooltipTrigger>
        {!due && (
          <TooltipContent>Checked within the last week; the next automatic check is due first.</TooltipContent>
        )}
      </Tooltip>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Icons } from "@/components/ui";
import { checkIndexing } from "@/app/actions/indexing";
import type { UrlInspection } from "@/lib/google/inspection";
import { coverageBucket } from "@/lib/gsc/analysis";
import { IndexBadge } from "./gsc-blocks";

/**
 * "Check indexing": one URL Inspection call for one article, on demand.
 *
 * The result is shown as Google phrased it. A failure is a sentence about
 * what to do next (publish first, connect Search Console, reconnect with
 * an owner account), never a silent "Unknown".
 */
export function IndexingStatus({ articleId, inspection, published }: { articleId: string; inspection: UrlInspection | null; published: boolean }) {
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setChecking(true);
    setNotice(null);
    try {
      const result = await checkIndexing(articleId);
      if (result.ok) {
        toast.success(result.inspection.coverageState ?? "Google answered");
        router.refresh();
      } else {
        setNotice(result.message);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The inspection failed.");
    } finally {
      setChecking(false);
    }
  }

  const bucket = coverageBucket(inspection, false);
  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IndexBadge bucket={bucket} />
          {inspection?.coverageState && <span className="text-[12px] text-ink-2">{inspection.coverageState}</span>}
        </div>
        <Button size="sm" onClick={run} disabled={checking || !published} title={published ? "Ask Google whether this URL is in its index" : "Publish first: Google can only be asked about a live URL"}>
          <Icons.refresh size={12} />
          {checking ? "Asking Google…" : "Check indexing"}
        </Button>
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-3">
        {inspection
          ? <>
              Checked {new Date(inspection.checkedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              {inspection.lastCrawlTime ? `; Google last crawled ${new Date(inspection.lastCrawlTime).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "; Google reports no crawl"}
              {inspection.googleCanonical && inspection.userCanonical && inspection.googleCanonical !== inspection.userCanonical
                ? `. Google chose a different canonical: ${inspection.googleCanonical}`
                : "."}
              {inspection.inspectionLink && (
                <>
                  {" "}
                  <a href={inspection.inspectionLink} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">Open in Search Console</a>
                </>
              )}
            </>
          : "Not checked yet. Unknown means nobody asked, not that Google said no."}
      </div>
      {notice && <div className="mt-1.5 text-[11.5px] text-warn-ink">{notice}</div>}
    </div>
  );
}

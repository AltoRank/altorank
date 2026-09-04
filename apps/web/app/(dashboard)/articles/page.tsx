import type { Metadata } from "next";
import Link from "next/link";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { createClient } from "@/lib/supabase/server";
import { PageHead, DotSep, StatStrip } from "@/components/ui";
import { ArticleActions } from "@/components/dashboard/article-actions";
import { ArticleHistory } from "@/components/dashboard/article-history";
import { HowItWorks } from "@/components/dashboard/how-it-works";
import { reviewExplainer } from "@/lib/explainers";
import { isHistoryFilter, toHistoryRow } from "@/lib/articles/history";
import type { Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Articles" };

type Props = {
  searchParams: Promise<{ status?: string }>;
};

export default async function ArticlesPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;
  // `?status=review` is what the banner and the old Review nav link to. It
  // preselects a chip; the filtering itself is client-side over the full
  // list, so the counts beside the other chips stay true.
  const initialStatus = isHistoryFilter(params.status) ? params.status : "all";

  const supabase = await createClient();
  const [workspaces, allArticles] = await Promise.all([
    getWorkspaces(),
    getArticles(scopeId ?? undefined),
  ]);

  // Which workspaces can publish from this list: the ones with a CMS
  // connected. The row menu offers "Publish now" for those; the rest are
  // sent to the editor, where the copy-and-record path lives.
  const { data: cmsRows } = workspaces.length
    ? await supabase
        .from("workspace_integrations")
        .select("workspace_id, integration:integrations(tag)")
        .in("workspace_id", workspaces.map((w) => w.id))
    : { data: [] as Array<{ workspace_id: string; integration: unknown }> };
  const cmsWorkspaces = new Set(
    (cmsRows ?? [])
      .filter((r) => (r.integration as { tag?: string } | null)?.tag === "CMS")
      .map((r) => r.workspace_id as string),
  );

  if (workspaces.length === 0) {
    return (
      <div className="p-8 text-ink-3">
        No sites yet.{" "}
        <Link href="/workspaces" className="text-accent-ink underline decoration-line underline-offset-[3px]">
          Add one
        </Link>{" "}
        and the first analysis starts on its own; articles are written for a site, so this page fills once there is one.
      </div>
    );
  }

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const site = wsMap.get(scopeId ?? "");
  const rows = allArticles.map((a) => toHistoryRow(a, cmsWorkspaces.has(a.workspace_id)));

  const liveCount = allArticles.filter((a) => a.status === "live").length;
  // Counted over the whole list, never over a filtered view: filtered onto
  // Live, this read as zero and hid the one thing waiting on a person
  // (2026-09-02).
  const reviewCount = allArticles.filter((a) => a.status === "review").length;
  const scored = allArticles.filter((a) => a.seo_score > 0);
  const avgScore = scored.length > 0
    ? Math.round(scored.reduce((s, a) => s + a.seo_score, 0) / scored.length)
    : 0;

  const autoOn = Boolean(site?.auto_generate) && site?.status !== "paused";

  return (
    <>
      <PageHead
        title="Articles"
        subtitle={
          <>
            <span>{plural(allArticles.length, "article")}</span>
            {site?.domain ? (
              <>
                <DotSep />
                <span className="font-mono text-[11.5px]">{site.domain}</span>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <HowItWorks explainer={reviewExplainer} />
            <ArticleActions workspaces={workspaces} articles={allArticles} scopedId={scopeId} />
          </>
        }
      />

      <StatStrip
        stats={[
          // Review leads the strip: it is the only number that is a request
          // for someone to do something (2026-09-02).
          { label: "Needs review", value: reviewCount, delta: reviewCount > 0 ? "waiting on you" : "nothing pending", deltaType: reviewCount > 0 ? "neg" : undefined },
          { label: "Live", value: liveCount, delta: `${liveCount} published`, deltaType: "pos" },
          { label: "Avg SEO score", value: avgScore || "—", delta: avgScore > 0 ? "from audits" : "no data" },
          { label: "Total", value: allArticles.length },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {/* The review queue used to be its own nav item, which meant the
            work waiting on a person lived one click away from the page they
            were already on. It is a banner here instead (2026-09-02). */}
        {reviewCount > 0 && initialStatus !== "review" && (
          <Link
            href="/articles?status=review"
            className="mb-4 flex items-center justify-between rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px] hover:border-ink-4"
          >
            <span>
              <strong className="font-medium">{plural(reviewCount, "article")}</strong>{" "}
              <span className="text-ink-3">drafted and waiting for your yes before publishing.</span>
            </span>
            <span className="text-accent-ink underline decoration-line underline-offset-[3px]">Review them</span>
          </Link>
        )}

        {/* Keyed on the preselected chip so following the banner link
            re-mounts with Review selected instead of keeping stale state. */}
        <ArticleHistory
          key={initialStatus}
          rows={rows}
          initialStatus={initialStatus}
          emptyState={
            <span className="inline-block max-w-[56ch] leading-[1.6]">
              No articles yet.{" "}
              {autoOn
                ? "The scheduler writes the next draft from the top of this site's keyword queue at 07:00 UTC (and again at 01:00, 13:00 and 19:00), or write one now with New article."
                : "Auto-generation is off for this site, so nothing is written on a schedule; write one now with New article, or turn the schedule on in the site's settings."}{" "}
              Every draft lands here in review and waits for your approval.
            </span>
          }
        />
      </div>
    </>
  );
}

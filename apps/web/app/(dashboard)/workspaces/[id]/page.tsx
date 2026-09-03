import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { getKeywords } from "@/lib/queries/keywords";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { getBacklinks } from "@/lib/queries/backlinks";
import { getVoiceProfile } from "@/lib/queries/voice";
import { getPublishingCadence } from "@/lib/queries/schedule";
import { PageHead, DotSep, StatusPill, Avatar, StatStrip } from "@/components/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ClientTabs } from "@/components/dashboard/client-tabs";
import { MetricHistory } from "@/components/dashboard/metric-history";
import { getWorkspaceMetrics } from "@/lib/queries/metrics";
import { getQuota } from "@/lib/billing/quota";
import { createClient } from "@/lib/supabase/server";
import { plural } from "@/lib/utils";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { id } = await params;
  const workspace = await getWorkspace(id);
  return { title: workspace?.name ?? "Client" };
}

export default async function ClientDetailPage({ params }: Props) {
  const { id } = await params;
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();

  const supabase = await createClient();
  const [articles, keywords, calendar, backlinks, voice, cadence, metrics, quota] =
    await Promise.all([
      getArticles(id),
      getKeywords(id),
      getCalendarEntries(id),
      getBacklinks(id),
      getVoiceProfile(id),
      getPublishingCadence(id),
      getWorkspaceMetrics(id),
      // Only for the writing-pace control, which says whether a setting
      // reaches the volume the plan includes. Null when unmetered.
      getQuota(supabase, workspace.agency_id),
    ]);

  // The clock FirstDraftLive measures a stalled draft against. It has to be
  // the server's: a client timer restarts whenever the tab is reopened, so a
  // draft that died an hour ago would read as "writing" for another ten
  // minutes on every visit.
  //
  // react-hooks flags Date.now() in a component body because an impure read
  // makes a client render non-idempotent. This is an async Server Component -
  // it runs once per request, and every poll is a new request - so there is no
  // re-render for the value to be unstable across.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const liveCount = articles.filter((a) => a.status === "live").length;
  const reviewCount = articles.filter((a) => a.status === "review").length;
  const avgScore = articles.length > 0
    ? Math.round(articles.reduce((s, a) => s + a.seo_score, 0) / articles.length)
    : 0;

  return (
    <>
      <PageHead
        title={
          <span className="flex items-center gap-3">
            <Avatar initials={workspace.initials} color={workspace.color} size="lg" className="w-[30px] h-[30px] text-xs" />
            {workspace.name}
          </span> as unknown as string
        }
        subtitle={
          <>
            <StatusPill status={workspace.status} />
            <span>{plural(articles.length, "article")}</span>
            <DotSep />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help border-b border-dotted border-line-soft">
                  {workspace.traffic?.toLocaleString() ?? "—"} organic /mo
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                Estimated monthly organic visits, from DataForSEO&rsquo;s traffic value for the
                terms this domain ranks for. An estimate from positions, not measured visits:
                Search Console is the measured one.
              </TooltipContent>
            </Tooltip>
            <DotSep />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help border-b border-dotted border-line-soft">
                  {typeof workspace.dr === "number" ? `Authority ${workspace.dr}` : "Authority —"}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[280px]">
                DataForSEO&rsquo;s domain rank from the backlink index, 0-1000, mapped to 0-100.
                It is not Ahrefs DR and the two will not match.
              </TooltipContent>
            </Tooltip>

          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Live", value: liveCount, delta: `${liveCount} published`, deltaType: "pos" },
          { label: "In review", value: reviewCount, delta: reviewCount > 0 ? "waiting on editor" : "none pending" },
          { label: "Keywords", value: keywords.length, delta: `${keywords.filter((k) => k.status === "new").length} new` },
          { label: "Avg SEO score", value: avgScore || "—", delta: avgScore > 0 ? "from audits" : "no data" },
        ]}
      />

      {metrics.length > 0 && (
        <div className="px-8 pt-4">
          <MetricHistory points={metrics} />
        </div>
      )}
      <ClientTabs
        workspace={workspace}
        now={now}
        articles={articles}
        keywords={keywords}
        calendar={calendar}
        backlinks={backlinks}
        voice={voice}
        cadence={cadence}
        planIncluded={quota.limit}
      />
    </>
  );
}

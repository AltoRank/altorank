import { notFound } from "next/navigation";
import { getWorkspace } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { getKeywords } from "@/lib/queries/keywords";
import { getCalendarEntries } from "@/lib/queries/calendar";
import { getBacklinks } from "@/lib/queries/backlinks";
import { getVoiceProfile } from "@/lib/queries/voice";
import { getPublishingCadence } from "@/lib/queries/schedule";
import { PageHead, DotSep, StatusPill, Avatar, StatStrip } from "@/components/ui";
import { ClientTabs } from "@/components/dashboard/client-tabs";
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

  const [articles, keywords, calendar, backlinks, voice, cadence] = await Promise.all([
    getArticles(id),
    getKeywords(id),
    getCalendarEntries(id),
    getBacklinks(id),
    getVoiceProfile(id),
    getPublishingCadence(id),
  ]);

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
            <span>{workspace.traffic?.toLocaleString() ?? "—"} organic /mo</span>
            <DotSep />
            <span>{typeof workspace.dr === "number" ? `Authority ${workspace.dr}` : "Authority —"}</span>

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

      <ClientTabs
        workspace={workspace}
        articles={articles}
        keywords={keywords}
        calendar={calendar}
        backlinks={backlinks}
        voice={voice}
        cadence={cadence}
      />
    </>
  );
}

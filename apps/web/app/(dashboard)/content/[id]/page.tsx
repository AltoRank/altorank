import type { Metadata } from "next";
import { getArticle } from "@/lib/queries/articles";
import { getWorkspace } from "@/lib/queries/workspaces";
import { getPublishingCadence } from "@/lib/queries/schedule";
import { PageHead, DotSep, StatusPill } from "@/components/ui";
import { ArticleEditor } from "@/components/dashboard/editor/article-editor";
import { needsPlanToShip } from "@/lib/billing/quota";
import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const article = await getArticle(id);
  return { title: article?.title ?? `Article ${id}` };
}

export default async function ArticleEditorPage({ params }: Props) {
  const { id } = await params;
  const article = await getArticle(id);
  if (!article) return notFound();

  const workspace = await getWorkspace(article.workspace_id);
  if (!workspace) return notFound();

  const cadence = await getPublishingCadence(workspace.id);
  const supabase = await createClient();
  const needsPlan = await needsPlanToShip(supabase, workspace.agency_id);

  const dateStr = article.updated_at
    ? new Date(article.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

  return (
    <>
      <PageHead
        title={article.title}
        backHref="/articles"
        backLabel="Back to articles"
        subtitle={
          <>
            <StatusPill status={article.status} />
            <span>{article.word_count ? `${article.word_count.toLocaleString()} words` : "Draft"}</span>
            <DotSep />
            <span className="font-mono truncate">/blog/{article.slug}</span>
            <DotSep />
            <span className="truncate">Updated {dateStr}</span>
          </>
        }
      />

      <ArticleEditor article={article} workspace={workspace} cadence={cadence} needsPlan={needsPlan} />
    </>
  );
}

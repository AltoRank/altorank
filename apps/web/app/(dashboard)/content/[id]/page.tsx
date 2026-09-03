import type { Metadata } from "next";
import { getArticle } from "@/lib/queries/articles";
import { getWorkspace } from "@/lib/queries/workspaces";
import { getIntegrations } from "@/lib/queries/integrations";
import { getPublishingCadence } from "@/lib/queries/schedule";
import { PageHead, DotSep, StatusPill } from "@/components/ui";
import { ArticleEditor } from "@/components/dashboard/editor/article-editor";
import { needsPlanToShip } from "@/lib/billing/quota";
import { getDestinations } from "@/lib/publishing/destinations";
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

  const supabase = await createClient();
  // All three only need the workspace, and none needs another. Awaited one
  // after the other they cost three round trips on the route the editor lives
  // behind; the article and workspace lookups above genuinely are a chain,
  // since each supplies the next one's id.
  const [cadence, needsPlan, destinations, integrations] = await Promise.all([
    getPublishingCadence(workspace.id),
    needsPlanToShip(supabase, workspace.agency_id),
    // The connected CMSs decide whether the editor offers a Publish button.
    // `articles.cms` used to, and nothing set it for a generated draft.
    getDestinations(supabase, workspace.id),
    // The catalogue rows, so the editor can open the connection dialog in
    // place instead of sending an unsaved draft to /connect.
    getIntegrations(),
  ]);

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

      <ArticleEditor
        article={article}
        workspace={workspace}
        cadence={cadence}
        needsPlan={needsPlan}
        destinations={destinations}
        integrations={integrations}
      />
    </>
  );
}

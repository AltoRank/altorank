import type { Metadata } from "next";
import Link from "next/link";
import { getArticle } from "@/lib/queries/articles";
import { getWorkspace } from "@/lib/queries/workspaces";
import { getPublishingCadence } from "@/lib/queries/schedule";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Button } from "@/components/ui";
import { ArticleEditor } from "@/components/dashboard/editor/article-editor";
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

  const dateStr = article.updated_at
    ? new Date(article.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "—";

  return (
    <>
      <PageHead
        title={article.title}
        eyebrow={
          <>
            <Link className="inline-flex items-center gap-1.5 text-ink-2 cursor-pointer hover:text-ink" href="/articles">
              <Icons.arrowLeft size={13} /> Back to articles
            </Link>
            <DotSep />
            <Avatar initials={workspace.initials} color={workspace.color} size="sm" className="w-[18px] h-[18px] text-[9px] rounded" />
            <span>{workspace.name}</span>
            <DotSep />
            <StatusPill status={article.status} />
            <span>Updated {dateStr}</span>
          </>
        }
        subtitle={
          <>
            <span className="font-mono">/blog/{article.slug}</span>
            <DotSep />
            <span>{article.word_count ? `${article.word_count.toLocaleString()} words` : "Draft"}</span>
            <DotSep />
            <span>Target keyword: <b className="text-ink">{article.keyword}</b></span>
          </>
        }
      />

      <ArticleEditor article={article} workspace={workspace} cadence={cadence} />
    </>
  );
}

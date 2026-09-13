import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireAuth } from "@/lib/auth/require-auth";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { createClient } from "@/lib/supabase/server";

type Node = { type?: string; text?: string; content?: Node[]; attrs?: { level?: number } };
// Render text as React nodes. Draft HTML, embeds and link attributes never
// become executable markup in the pre-purchase preview.
function body(node: Node, key = "root"): ReactNode {
  if (node.type === "text") return node.text ?? "";
  const children = (node.content ?? []).map((child, i) => body(child, `${key}-${i}`));
  switch (node.type) {
    case "heading": return <h2 key={key} className="mb-3 mt-7 text-xl font-semibold">{children}</h2>;
    case "paragraph": return <p key={key} className="mb-4">{children}</p>;
    case "bulletList": return <ul key={key} className="mb-4 list-disc pl-6">{children}</ul>;
    case "orderedList": return <ol key={key} className="mb-4 list-decimal pl-6">{children}</ol>;
    case "listItem": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key} className="border-l-2 pl-4">{children}</blockquote>;
    case "codeBlock": return <pre key={key} className="overflow-auto whitespace-pre-wrap">{children}</pre>;
    case "hardBreak": return <br key={key} />;
    case "table": return <table key={key}><tbody>{children}</tbody></table>;
    case "tableRow": return <tr key={key}>{children}</tr>;
    case "tableCell": return <td key={key} className="border p-2">{children}</td>;
    case "tableHeader": return <th key={key} className="border p-2">{children}</th>;
    default: return <span key={key}>{children}</span>;
  }
}
export default async function DraftPreview({ params }: { params: Promise<{ id: string }> }) {
  const { accountId } = await requireAuth();
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  const { id } = await params;
  const supabase = await createClient();
  const { data: workspace } = await supabase.from("workspaces").select("id").eq("id", workspaceId).eq("account_id", accountId).maybeSingle();
  if (!workspace) notFound();
  const { data: article } = await supabase.from("articles").select("id, title, content, keyword, word_count, status").eq("workspace_id", workspaceId).eq("id", id).in("status", ["review", "approved", "scheduled", "live"]).maybeSingle();
  if (!article?.content) notFound();
  return <main className="mx-auto max-w-3xl px-6 py-10">
    <Link href="/onboarding" className="text-accent">← Back to your draft and plan</Link>
    <p className="mt-5 text-sm text-ink-3">Read-only preview · {article.word_count ?? 0} words · {article.keyword}</p>
    <h1 className="my-6 text-3xl font-semibold">{article.title}</h1>
    <article className="leading-7">{body(article.content as Node)}</article>
    <Link href="/onboarding" className="mt-8 inline-block text-accent">Return to trial options</Link>
  </main>;
}

import Link from "next/link";
import { TrialOffer } from "@/components/billing/trial-offer";
import { getRequestQuota } from "@/lib/queries/quota";
import { notFound, redirect } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { requireAuth } from "@/lib/auth/require-auth";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { createClient } from "@/lib/supabase/server";

type Node = { type?: string; text?: string; content?: Node[]; attrs?: { level?: number }; marks?: Array<{ type?: string; attrs?: { href?: string } }> };
// Render draft nodes as React elements. Only validated http(s) citation links
// survive; raw HTML and embeds never become executable preview markup.
function body(node: Node, key = "root"): ReactNode {
  if (node.type === "text") {
    let text: ReactNode = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") text = <strong>{text}</strong>;
      if (mark.type === "italic") text = <em>{text}</em>;
      if (mark.type === "link") {
        try {
          const url = new URL(mark.attrs?.href ?? "");
          if (/^https?:$/.test(url.protocol) && !url.username && !url.password) text = <a className="text-accent underline" href={url.href} target="_blank" rel="noopener noreferrer">{text}</a>;
        } catch { /* Invalid draft links remain readable text. */ }
      }
    }
    return <Fragment key={key}>{text}</Fragment>;
  }
  const children = (node.content ?? []).map((child, i) => body(child, `${key}-${i}`));
  switch (node.type) {
    case "heading": return node.attrs?.level === 1 ? null : <h2 key={key} className="mb-3 mt-7 text-xl font-semibold">{children}</h2>;
    case "paragraph": return <p key={key} className="mb-4">{children}</p>;
    case "bulletList": return <ul key={key} className="mb-4 list-disc pl-6">{children}</ul>;
    case "orderedList": return <ol key={key} className="mb-4 list-decimal pl-6">{children}</ol>;
    case "listItem": return <li key={key}>{children}</li>;
    case "blockquote": return <blockquote key={key} className="border-l-2 pl-4">{children}</blockquote>;
    case "codeBlock": return <pre key={key} className="overflow-auto whitespace-pre-wrap">{children}</pre>;
    case "hardBreak": return <br key={key} />;
    case "table": return <div key={key} className="mb-4 max-w-full overflow-x-auto"><table className="w-full text-sm"><tbody>{children}</tbody></table></div>;
    case "tableRow": return <tr key={key}>{children}</tr>;
    case "tableCell": return <td key={key} className="border p-2">{children}</td>;
    case "tableHeader": return <th key={key} className="border p-2">{children}</th>;
    default: return <Fragment key={key}>{children}</Fragment>;
  }
}
export default async function DraftPreview({ params }: { params: Promise<{ id: string }> }) {
  const { accountId, role, user } = await requireAuth();
  const workspaceId = await getScopedWorkspaceId();
  if (!workspaceId) redirect("/onboarding");
  const { id } = await params;
  const supabase = await createClient();
  const { data: workspace } = await supabase.from("workspaces").select("id").eq("id", workspaceId).eq("account_id", accountId).maybeSingle();
  if (!workspace) notFound();
  const { data: article } = await supabase.from("articles").select("id, title, content, keyword, word_count, status, research, fact_checks").eq("workspace_id", workspaceId).eq("id", id).in("status", ["review", "approved", "scheduled", "live"]).maybeSingle();
  if (!article?.content) notFound();
  const quota = await getRequestQuota(accountId, user.email ?? null);
  const review = (article.research as { editorialReview?: import("@/lib/content/approved-output").EditorialReview } | null)?.editorialReview;
  const figures = article.fact_checks as { verdict?: string; claims?: unknown[] } | null;
  return <main className="mx-auto min-w-0 max-w-3xl break-words px-6 py-10">
    <Link href="/onboarding" className="text-accent">← Back to your draft and plan</Link>
    <p className="mt-5 text-sm text-ink-3">Read-only preview · {article.word_count ?? 0} words · {article.keyword}</p>
    <h1 className="my-6 text-3xl font-semibold">{article.title}</h1>
    <article className="leading-7">{body(article.content as Node)}</article>
    <section className="mb-6 rounded-lg border border-line p-4 text-sm" aria-label="Draft checks">
      <h2 className="mb-2 font-semibold">What was checked</h2>
      <p>Numbers and citations: {figures?.verdict === "clean" ? "No issues detected by targeted checks; this is not a comprehensive factual approval." : "Review the cited evidence before publishing."}</p>
      <p>Product claims: {review?.productClaims?.replaceAll("-", " ") ?? "not checked"}.</p>
      <p>Qualitative claims: {review?.qualitativeClaims?.replaceAll("-", " ") ?? "not checked"}.</p>
      <p>Structure: {review?.structure?.replaceAll("-", " ") ?? "not checked"}.</p>
      {review?.findings.map((finding, i) => <p key={i} className="mt-2">{finding.removed ? "Removed" : "Needs review"}: {finding.reason}</p>)}
    </section>
    {quota.trialEligible && quota.reason === "no-plan" && <section className="mt-8" aria-label="Continue with your draft"><h2 className="mb-3 text-xl font-semibold">Keep writing for your business</h2><p className="mb-4 text-sm text-ink-2">Your draft is saved. Start a trial to edit, approve and publish, and continue with your next articles.</p><TrialOffer canBuy={role === "owner"} returnTo={`/content/${article.id}`} /></section>}
    <Link href="/onboarding" className="mt-8 inline-block text-accent">Back to your article ideas</Link>
  </main>;
}

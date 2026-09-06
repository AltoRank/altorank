import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead, DotSep } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { getDestinations } from "@/lib/publishing/destinations";
import { UPDATABLE_CMS } from "@/lib/refresh/push";
import { readDecisions } from "@/lib/refresh/hunks";
import { OPPORTUNITY_LABELS, type Opportunity, type RefreshCandidate, type RefreshExecution } from "@/lib/refresh/types";
import { ReviewExecution } from "@/components/dashboard/improvements/review-execution";

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: "Review rewrite" };

/**
 * One rewrite, block by block. The page loads what the reviewer needs to
 * decide and what the push needs to know it can run: whether this is a page
 * we published, and whether the connected CMS can edit it in place.
 */
export default async function ReviewExecutionPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("refresh_executions")
    .select("*, task:refresh_tasks(candidate:refresh_candidates(*))")
    .eq("id", id)
    .maybeSingle();
  if (!row) return notFound();
  const execution = row as unknown as RefreshExecution;
  const candidate = ((row.task as { candidate?: RefreshCandidate } | null)?.candidate ?? null) as RefreshCandidate | null;
  if (!candidate) return notFound();

  const [{ data: article }, destinations] = await Promise.all([
    candidate.article_id
      ? supabase
          .from("articles")
          .select("id, title, external_id, published_url, cms")
          .eq("id", candidate.article_id)
          .eq("workspace_id", execution.workspace_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    getDestinations(supabase, execution.workspace_id),
  ]);

  const destination = destinations.find((d) => d.type === article?.cms || d.integrationId === article?.cms) ?? destinations[0] ?? null;
  const adapterCanUpdate = destination ? UPDATABLE_CMS.has(destination.type) : false;

  // Why "Push to site" is or is not available, in the reviewer's terms.
  let pushBlocker: string | null = null;
  if (!candidate.article_id) {
    pushBlocker = "This page was not published through AltoRank, so there is no post to update. Copy the HTML or download the Markdown and apply it in your CMS.";
  } else if (!article?.external_id) {
    pushBlocker = "This article was published by hand, so there is no CMS post id to update. Copy the HTML instead.";
  } else if (!destination) {
    pushBlocker = "No CMS is connected to this site. Connect one under Integrations, or copy the HTML.";
  } else if (!adapterCanUpdate) {
    pushBlocker = `The ${destination.label} connection can publish new posts but cannot yet edit an existing one, and a second copy of this page would be worse than no push. Copy the HTML and update the post in ${destination.label}.`;
  }

  const title = article?.title ?? execution.before?.title ?? candidate.url;

  return (
    <>
      <PageHead
        title={title}
        backHref="/improvements"
        backLabel="Back to improvements"
        subtitle={
          <>
            <span>{OPPORTUNITY_LABELS[candidate.opportunity as Opportunity]}</span>
            <DotSep />
            <a href={candidate.url} target="_blank" rel="noreferrer" className="font-mono truncate hover:underline">
              {candidate.url.replace(/^https?:\/\//, "")}
            </a>
          </>
        }
      />
      <ReviewExecution
        executionId={execution.id}
        reviewStatus={execution.review_status}
        hunks={execution.hunks}
        issues={execution.validation_issues ?? []}
        before={{ title: execution.before?.title ?? null, metaDescription: execution.before?.metaDescription ?? null }}
        after={{ title: execution.after?.title ?? null, metaDescription: execution.after?.metaDescription ?? null }}
        initialDecisions={readDecisions(execution.decisions)}
        pushBlocker={pushBlocker}
        destinationLabel={destination?.label ?? null}
        publishedUrl={execution.published_url ?? article?.published_url ?? null}
        brief={candidate.brief}
        evidence={candidate.evidence}
      />
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHead, Card } from "@/components/ui";
import { createServiceClient } from "@/lib/supabase/server";
import { getOperator } from "@/lib/auth/admin";
import { notRegenerableReason, type RegenerableRow } from "@/lib/content/regenerate-draft";
import { AdminTabs } from "../admin-tabs";
import { Table } from "../table";
import { RegenerateButton } from "./regenerate-button";

export const metadata: Metadata = { title: "Drafts" };

/** How far back the list reaches. Older drafts are not what this is for. */
const DAYS = 14;

function windowStart(): string {
  return new Date(Date.now() - DAYS * 86_400_000).toISOString();
}

/**
 * Recent drafts across every account, newest first, each with Regenerate:
 * rewrite it in place through the writer as it is now
 * (lib/content/regenerate-draft.ts). For the draft a writer fix arrived too
 * late for. Operator-gated and read through the service client, like the
 * other Operations panes.
 */
export default async function AdminDraftsPage() {
  const operator = await getOperator();
  if (!operator) notFound();

  const admin = createServiceClient();
  const since = windowStart();
  const [{ data, error }, { data: workspaces }] = await Promise.all([
    admin
      .from("articles")
      .select("id, workspace_id, title, keyword, word_count, fact_check_verdict, created_at, status, approved_at, published_url, published_at, external_id, scheduled_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(100),
    admin.from("workspaces").select("id, domain"),
  ]);
  const domainOf = new Map((workspaces ?? []).map((w) => [w.id as string, (w.domain as string | null) ?? "—"]));
  const rows = data ?? [];

  return (
    <>
      <PageHead title="Operations" subtitle={<span>{error ? `Drafts could not be read: ${error.message}` : `${rows.length} drafts in the last ${DAYS} days · newest first`}</span>} />
      <AdminTabs />
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        <Card
          className="shrink-0"
          title="Recent drafts"
          meta="Regenerate rewrites a draft in place with the current writer, unbilled and uncounted. Only drafts nobody has approved, scheduled or published. The old text is not kept."
          flush
        >
          <Table
            head={["Draft", "Site", "Words", "Fact check", "Status", "Written", ""]}
            empty="No drafts in this window."
            rows={rows.map((r) => [
              <span key="t" className="text-ink">{(r.title as string | null) ?? (r.keyword as string)}</span>,
              domainOf.get(r.workspace_id as string) ?? "—",
              String(r.word_count ?? 0),
              (r.fact_check_verdict as string | null) ?? "—",
              r.status as string,
              new Date(r.created_at as string).toISOString().slice(0, 16).replace("T", " "),
              <RegenerateButton
                key="b"
                articleId={r.id as string}
                title={(r.title as string | null) ?? (r.keyword as string)}
                disabledReason={notRegenerableReason(r as unknown as RegenerableRow) ?? undefined}
              />,
            ])}
          />
        </Card>
      </div>
    </>
  );
}

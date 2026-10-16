import { NextResponse } from "next/server";
import { tiptapToHtml } from "@/lib/cms/html";
import { readArticlesWhole } from "@/lib/articles/body-read";
import { accountTrialGate } from "@/lib/billing/body-lock";
import { needsPlanToShip, CHOOSE_PLAN_MESSAGE } from "@/lib/billing/quota";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial-refusal";
import { STATUS_LABELS } from "@/lib/agent/records";
import { authenticateLinkedShop } from "@/lib/shopify/request-auth";
import type { Article } from "@/lib/types";

/**
 * GET /api/shopify/articles/:id - one article for the embedded preview.
 *
 * The id is only trusted after a read scoped to the store's own site; the
 * body comes from the server-only reader (migration 097) and only while the
 * account's body gate is open, the same rule the dashboard's editor follows.
 * The HTML goes into a sandboxed iframe on the client, never into the page.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateLinkedShop(request);
  if (!auth.ok) return auth.response;
  const { supabase, installation } = auth.ctx;
  const { id } = await params;

  const { data: row } = await supabase
    .from("articles")
    .select("id, title, keyword, status")
    .eq("id", id)
    .eq("workspace_id", installation.workspaceId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Article not found" }, { status: 404 });

  const [gate, needsPlan] = await Promise.all([
    accountTrialGate(supabase, installation.accountId, null),
    needsPlanToShip(supabase, installation.accountId, null),
  ]);
  const locked = gate === "gated";

  let html: string;
  if (locked) {
    html = `<p style="font-family:sans-serif;color:#555">${BODY_LOCKED_MESSAGE}</p>`;
  } else {
    const [article] = await readArticlesWhole<{ content: unknown }>([id], "id, content");
    html = article?.content ? tiptapToHtml(article.content as Record<string, unknown>) : "<p>This draft has no text yet.</p>";
  }

  const status = row.status as Article["status"];
  const inReview = status === "review";
  return NextResponse.json({
    id: row.id,
    title: (row.title as string) || "Untitled draft",
    keyword: (row.keyword as string) || "",
    status,
    statusLabel: STATUS_LABELS[status] ?? status,
    html,
    canApprove: inReview && !needsPlan && !locked,
    approveBlockedReason: !inReview ? "" : needsPlan ? CHOOSE_PLAN_MESSAGE : locked ? BODY_LOCKED_MESSAGE : "",
  });
}

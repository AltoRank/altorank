"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { creditsForDR, getCreditBalance, scoreRelevance, suggestPlacement, insertBacklinkIntoContent } from "@/lib/seo/exchange";
import { recommendKeywords, pickNextKeyword } from "@/lib/seo/recommendations";
import { generateArticle } from "@/lib/content/generate";

/**
 * Create a new backlink exchange request.
 */
export async function createExchangeRequest(
  workspaceId: string,
  targetUrl: string,
  targetKeyword: string,
  targetTopic: string,
) {
  // Derive agency from the authenticated session — never trust a caller-supplied
  // agencyId (that was an IDOR: a user could create requests as another agency).
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  // Verify the workspace belongs to the caller's agency (defense-in-depth over RLS).
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("dr")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .single();

  if (!workspace) throw new Error("Workspace not found or not in your account");

  // Null when the requesting workspace has no measured DR. Advertising a price
  // derived from a DR nobody took is worse than advertising none.
  const creditsOffered = creditsForDR(workspace.dr);

  const { error } = await supabase.from("backlink_exchanges").insert({
    requester_agency_id: agencyId,
    requester_workspace_id: workspaceId,
    target_url: targetUrl,
    target_keyword: targetKeyword,
    target_topic: targetTopic,
    credits_offered: creditsOffered,
    status: "requested",
  });

  if (error) throw new Error(error.message);
  revalidatePath("/backlinks");
}

/**
 * Host somebody else's request: write an article for your own blog.
 *
 * This is the half of the exchange that never existed. `acceptExchange`,
 * `placeExchange` and `verifyExchange` are gone with it, and what they did is
 * worth stating plainly, because it is the reason the feature was pointless:
 * they appended one sentence with a link into an article the host had ALREADY
 * published, priced it by the host's domain rating, forced
 * `rel="nofollow sponsored"` on it, and moved credits only once that link was
 * verified live. A link nobody chose, in a page nobody re-read, paying no
 * authority. Nothing to want on either side.
 *
 * What happens now: the engine writes a full article for the host's own blog,
 * on a keyword from the host's own recommendation queue, and it lands in the
 * host's review queue as a draft like any other. The requester's page is
 * inserted as one citation. The host reads it, edits it, keeps or cuts the
 * citation, and approves or rejects. Credits settle when it publishes.
 *
 * So the host is paid in content first and credits second, and the requester
 * buys a mention on a page a person chose to publish. The citation stays
 * `nofollow sponsored`: the host is still being compensated in connection with
 * publishing it, and pretending otherwise would be the link scheme this
 * refuses to be. See the disclaimer on the request form.
 */
export type HostRequestState =
  | { ok: true; keyword: string; relevance: number }
  | { ok: false; error: string }
  | null;

/** Below this, the request is not something this site's audience would want. */
const RELEVANCE_THRESHOLD = 0.6;

export async function hostExchangeRequest(
  _prev: HostRequestState,
  formData: FormData,
): Promise<HostRequestState> {
  const exchangeId = String(formData.get("exchange_id") ?? "");
  const workspaceId = String(formData.get("workspace_id") ?? "");
  if (!exchangeId || !workspaceId) return { ok: false, error: "Pick a site to publish it on." };

  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, domain")
    .eq("id", workspaceId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (!workspace) return { ok: false, error: "That site is not in your account." };

  // The request itself is another tenant's row, so reading and claiming it
  // needs the service role; every condition that makes it claimable is
  // checked here rather than trusted from the browser.
  const admin = createServiceClient();
  const { data: exchange } = await admin
    .from("backlink_exchanges")
    .select("id, status, requester_agency_id, provider_agency_id, target_url, target_keyword, target_topic, expires_at")
    .eq("id", exchangeId)
    .maybeSingle();
  if (!exchange) return { ok: false, error: "That request no longer exists." };
  if (exchange.requester_agency_id === agencyId) return { ok: false, error: "That is your own request." };
  if (exchange.status !== "requested" || exchange.provider_agency_id) {
    return { ok: false, error: "Somebody else has already taken that request." };
  }
  if (exchange.expires_at && new Date(exchange.expires_at as string) < new Date()) {
    return { ok: false, error: "That request has expired." };
  }

  // The host's own keyword queue decides the subject. The article has to be
  // one this site wanted anyway, or it is a link dressed as content.
  let recommendations;
  try {
    recommendations = await recommendKeywords(supabase, workspaceId, { limit: 25 });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not read your keywords." };
  }
  const next = pickNextKeyword(recommendations);
  if (!next) {
    return {
      ok: false,
      error: `There is no keyword worth writing for ${workspace.domain ?? workspace.name} yet. Run keyword research first; the article has to be one your own audience wants.`,
    };
  }

  // Fail closed: scoreRelevance returns 0.5 when it cannot assess, which is
  // below the threshold, so an unassessable match is refused rather than run.
  const relevance = await scoreRelevance(
    next.term,
    next.term,
    (exchange.target_topic as string | null) ?? "",
    (exchange.target_keyword as string | null) ?? "",
  );
  if (relevance < RELEVANCE_THRESHOLD) {
    return {
      ok: false,
      error: `Too far from your topics (${relevance.toFixed(2)} of ${RELEVANCE_THRESHOLD}). Your next article is about "${next.term}", and a citation to that page would not belong in it.`,
    };
  }

  const { error: claimErr } = await admin
    .from("backlink_exchanges")
    .update({
      provider_agency_id: agencyId,
      provider_workspace_id: workspaceId,
      relevance_score: relevance,
      status: "accepted",
      matched_at: new Date().toISOString(),
    })
    .eq("id", exchangeId)
    // Claim only if still unclaimed: two hosts pressing at once must not both win.
    .eq("status", "requested")
    .is("provider_agency_id", null);
  if (claimErr) return { ok: false, error: claimErr.message };

  /**
   * Writing is a long model call, so it happens after the response and the
   * draft appears in the review queue a few minutes later. A failure releases
   * the claim rather than parking the request on a host that never delivered.
   */
  after(async () => {
    try {
      const bg = await createClient();
      const result = await generateArticle({
        supabase: bg,
        workspaceId,
        keyword: next.term,
        autonomous: true,
        selection: { reasons: next.reasons, score: next.score, difficulty: next.difficulty, volume: next.volume },
      });

      // One citation, inserted into the draft rather than into a published
      // page, which is the difference between a suggestion and an edit to
      // someone's live site. The host can delete it and still be paid.
      const { data: article } = await bg
        .from("articles")
        .select("content")
        .eq("id", result.articleId)
        .maybeSingle();
      if (article?.content) {
        const placement = await suggestPlacement(
          JSON.stringify(article.content).slice(0, 3000),
          exchange.target_url as string,
          (exchange.target_keyword as string | null) ?? "",
        );
        const withCitation = insertBacklinkIntoContent(
          article.content as Parameters<typeof insertBacklinkIntoContent>[0],
          exchange.target_url as string,
          placement.anchorText || (exchange.target_keyword as string | null) || "this resource",
          placement.paragraphIndex ?? 1,
        );
        await bg.from("articles").update({ content: withCitation }).eq("id", result.articleId);
      }

      await admin
        .from("backlink_exchanges")
        .update({
          provider_article_id: result.articleId,
          status: "placed",
          placed_at: new Date().toISOString(),
        })
        .eq("id", exchangeId);
    } catch (err) {
      console.error("[exchange] hosting failed, releasing the claim:", err instanceof Error ? err.message : err);
      await admin
        .from("backlink_exchanges")
        .update({ provider_agency_id: null, provider_workspace_id: null, status: "requested", matched_at: null })
        .eq("id", exchangeId);
    }
  });

  revalidatePath("/backlinks");
  return { ok: true, keyword: next.term, relevance };
}

/**
 * Get credit balance for the current user's agency.
 */
export async function getAgencyCreditBalance(): Promise<number> {
  // Balance is always the caller's own agency — derive it, don't accept it.
  const { agencyId } = await requireAuth();
  const supabase = await createClient();
  return getCreditBalance(supabase, agencyId);
}

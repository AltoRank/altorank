"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { creditsForDR, recordCredit, getCreditBalance, scoreRelevance, suggestPlacement, placeBacklinkInArticle, verifyPlacementLive } from "@/lib/seo/exchange";

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
 * Accept an exchange request — provider agrees to host the link.
 */
export async function acceptExchange(
  exchangeId: string,
  providerWorkspaceId: string,
  providerArticleId: string,
) {
  // Provider agency comes from the session, not a parameter (IDOR fix).
  const { agencyId: providerAgencyId } = await requireAuth();
  const supabase = await createClient();

  // Verify the provider workspace belongs to the caller's agency.
  const { data: providerWs } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", providerWorkspaceId)
    .eq("agency_id", providerAgencyId)
    .single();
  if (!providerWs) throw new Error("Provider workspace not found or not in your account");

  // Fetch the exchange
  const { data: exchange, error: fetchErr } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .eq("id", exchangeId)
    .single();

  if (fetchErr || !exchange) throw new Error("Exchange not found");
  if (exchange.status !== "requested" && exchange.status !== "matched") {
    throw new Error(`Cannot accept exchange in status: ${exchange.status}`);
  }
  // No self-dealing: you can't host the link for your own request.
  if (exchange.requester_agency_id === providerAgencyId) {
    throw new Error("You cannot accept your own exchange request");
  }

  // Fetch the provider article — scoped to the verified provider workspace.
  const { data: article } = await supabase
    .from("articles")
    .select("title, keyword, content")
    .eq("id", providerArticleId)
    .eq("workspace_id", providerWorkspaceId)
    .single();
  if (!article) throw new Error("Article not found in your workspace");

  // Relevance gate (fail closed): refuse low-relevance hosts. scoreRelevance
  // returns 0.5 when it can't assess (no key / parse failure) — below the
  // threshold — so an unassessable match is rejected rather than placed.
  const relevanceScore = await scoreRelevance(
    article.title,
    article.keyword ?? "",
    exchange.target_topic ?? "",
    exchange.target_keyword ?? "",
  );
  const RELEVANCE_THRESHOLD = 0.6;
  if (relevanceScore < RELEVANCE_THRESHOLD) {
    throw new Error(
      `Topical relevance too low (${relevanceScore.toFixed(2)} < ${RELEVANCE_THRESHOLD}) — this article isn't a relevant host for that link.`,
    );
  }

  let suggestedPlacement = null;
  if (article.content) {
    suggestedPlacement = await suggestPlacement(
      JSON.stringify(article.content).slice(0, 3000),
      exchange.target_url,
      exchange.target_keyword ?? "",
    );
  }

  // Update exchange
  const { error: updateErr } = await supabase
    .from("backlink_exchanges")
    .update({
      provider_agency_id: providerAgencyId,
      provider_workspace_id: providerWorkspaceId,
      provider_article_id: providerArticleId,
      relevance_score: relevanceScore,
      suggested_placement: suggestedPlacement,
      status: "accepted",
      matched_at: new Date().toISOString(),
    })
    .eq("id", exchangeId);

  if (updateErr) throw new Error(updateErr.message);
  revalidatePath("/backlinks");
}

/**
 * Verify an exchange — link has been placed, credits are transferred.
 */
export async function verifyExchange(exchangeId: string) {
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { data: exchange, error } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .eq("id", exchangeId)
    .single();

  if (error || !exchange) throw new Error("Exchange not found");
  // Only a participant agency may verify (it moves credits between both sides).
  if (
    exchange.requester_agency_id !== agencyId &&
    exchange.provider_agency_id !== agencyId
  ) {
    throw new Error("Not a participant in this exchange");
  }
  if (exchange.status !== "placed") {
    throw new Error(`Cannot verify exchange in status: ${exchange.status}`);
  }

  // Get provider workspace DR for credit calculation
  const { data: providerWs } = await supabase
    .from("workspaces")
    .select("dr")
    .eq("id", exchange.provider_workspace_id)
    .single();

  // Price the trade before doing it. An unmeasured host cannot be priced, and
  // settling at the cheapest tier would pay a strong host and a worthless one
  // the same — which is what made the tier table decorative.
  const credits = creditsForDR(providerWs?.dr);
  if (credits === null) {
    throw new Error(
      "The hosting workspace has no measured domain rating, so this placement cannot be priced. Measure DR before settling the exchange.",
    );
  }

  // The link has to exist on the public web before any credit moves. Until this
  // check existed, "verified" meant "somebody clicked verify".
  const { data: providerArticle } = await supabase
    .from("articles")
    .select("published_url")
    .eq("id", exchange.provider_article_id)
    .single();

  const verdict = await verifyPlacementLive(
    providerArticle?.published_url ?? null,
    exchange.target_url,
  );
  if (!verdict.ok) {
    throw new Error(`Placement not verified: ${verdict.reason}`);
  }

  // Provider earns credits for hosting the link
  await recordCredit(
    supabase,
    exchange.provider_agency_id,
    credits,
    "host_link",
    exchangeId,
    providerWs!.dr,
  );

  // Requester spends credits for placing their link
  await recordCredit(
    supabase,
    exchange.requester_agency_id,
    -credits,
    "place_link",
    exchangeId,
    providerWs!.dr,
  );

  // Update exchange status. placement_url is recorded here because this is the
  // first point at which we know a real URL served the link.
  await supabase
    .from("backlink_exchanges")
    .update({
      status: "verified",
      placement_url: verdict.url,
      verified_at: new Date().toISOString(),
    })
    .eq("id", exchangeId);

  revalidatePath("/backlinks");
}

/**
 * Place the backlink into the provider's article content.
 * Transitions exchange from "accepted" → "placed".
 */
export async function placeExchange(exchangeId: string) {
  // Only the provider agency may place the link into its own article.
  const { agencyId } = await requireAuth();
  const supabase = await createClient();

  const { data: exchange } = await supabase
    .from("backlink_exchanges")
    .select("provider_agency_id")
    .eq("id", exchangeId)
    .single();
  if (!exchange || exchange.provider_agency_id !== agencyId) {
    throw new Error("Only the provider can place this link");
  }

  await placeBacklinkInArticle(supabase, exchangeId);
  revalidatePath("/backlinks");
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

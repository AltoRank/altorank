import { z } from "zod";
import { withAgent, readJson } from "@/lib/agent/http";
import { fail, ok } from "@/lib/agent/envelope";
import { workspaceInAccount } from "@/lib/agent/data";
import { discoverKeywords, discoverKeywordsFromSeeds } from "@/lib/seo/keywords";
import { hasDataForSEOCredentials } from "@/lib/seo/client";
import { canSpend } from "@/lib/billing/spend-gate";

export const maxDuration = 60;

const bodySchema = z.object({
  workspace_id: z.uuid(),
  /** Phrases to expand. Without them the site's own domain is the seed. */
  seeds: z.array(z.string().trim().min(3)).max(5).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/**
 * POST /api/agent/v1/keywords/suggest
 *
 * The same two lookups the dashboard's research button and the first-look
 * analysis use, read-only: nothing is written to the keywords table. The
 * agent shows the candidates to the human; POST /articles/generate is how one
 * of them becomes a draft.
 */
export const POST = withAgent(async (request, ctx) => {
  const parsed = await readJson<unknown>(request);
  if ("envelope" in parsed) return parsed.envelope;
  const body = bodySchema.safeParse(parsed.body);
  if (!body.success) {
    return fail(
      "invalid_request",
      body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      "Send { workspace_id, seeds?: string[] (max 5), limit?: number }.",
    );
  }

  const workspace = await workspaceInAccount(ctx, body.data.workspace_id);
  if (!workspace) {
    return fail("not_found", "Workspace not found in this account.", "Call GET /workspaces and use an id from that list.");
  }
  if (!hasDataForSEOCredentials()) {
    return fail(
      "not_available",
      "Keyword research is not configured on this install.",
      "This AltoRank has no DataForSEO credentials. Tell the human; keyword suggestions need them.",
    );
  }

  // Two DataForSEO look-ups of up to 200 rows. This route is declared `read`,
  // and a read scope buying provider data was the one hole on the whole agent
  // and MCP surface: `altorank_suggest_keywords` spent money for an account
  // with no plan, from a key that is not allowed to write anything.
  // `null` for the address is right here: an API key is nobody's session.
  const gate = await canSpend(ctx.supabase, ctx.accountId, {
    userEmail: null,
    workspaceId: workspace.id,
    action: "keyword-research",
  });
  if (!gate.allowed) {
    return fail(
      "quota_exceeded",
      gate.message,
      "Do not retry. Tell the human what this says and let them decide; a plan is chosen on the Billing page, not by an agent.",
    );
  }

  const locale = { languageCode: workspace.language ?? "en", locationCode: workspace.location_code ?? 2840 };
  const seeds = body.data.seeds?.filter(Boolean) ?? [];
  let candidates;
  let source: "seeds" | "site";
  if (seeds.length) {
    source = "seeds";
    candidates = await discoverKeywordsFromSeeds(seeds, { ...locale, limit: body.data.limit });
  } else {
    if (!workspace.domain) {
      return fail("invalid_request", "This workspace has no domain.", "Pass seeds, or ask the human to set the workspace's domain.");
    }
    source = "site";
    candidates = (await discoverKeywords(workspace.domain, { ...locale, withDifficulty: true }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, body.data.limit);
  }

  const shaped = candidates.map((k) => ({
    keyword: k.keyword,
    volume: k.volume,
    difficulty: k.difficulty,
    intent: k.intent,
    cpc: k.cpc,
  }));

  return ok(
    { workspace_id: workspace.id, source, seeds, candidates: shaped, count: shaped.length, saved: false },
    shaped.length
      ? "These are candidates, not saved keywords. Show the human the top few with volume and difficulty (null = unmeasured), agree on one, then POST /articles/generate with it."
      : "No candidates came back. Try seeds closer to what the site actually sells, or tell the human the research source returned nothing for this locale.",
  );
}, { scope: "read" });

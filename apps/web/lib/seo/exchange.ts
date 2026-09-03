import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "@/lib/ai/models";
import { fetchSite } from "@/lib/audit/lenient-fetch";

// Tiptap node types (minimal, matching lib/ai/tiptap.ts)
type TiptapMark = { type: string; attrs?: Record<string, unknown> };
type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
};
type TiptapDoc = { type: "doc"; content: TiptapNode[] };

/**
 * Calculate credits for a given DR using tiered formula:
 * DR 0-20 = 1, 21-40 = 2, 41-60 = 4, 61-80 = 8, 81-100 = 16
 *
 * Returns null for an unmeasured DR rather than falling through to the cheapest
 * tier. Callers used to pass `workspace.dr ?? 0`, which priced every unmeasured
 * host at 1 credit — the same as a genuinely worthless one — so the tiers did
 * nothing and the price looked derived when it was invented.
 */
export function creditsForDR(dr: number | null | undefined): number | null {
  if (dr === null || dr === undefined) return null;
  if (dr <= 20) return 1;
  if (dr <= 40) return 2;
  if (dr <= 60) return 4;
  if (dr <= 80) return 8;
  return 16;
}

/**
 * Get the credit balance for an agency (sum of all credits).
 */
export async function getCreditBalance(
  supabase: SupabaseClient,
  agencyId: string,
): Promise<number> {
  const { data } = await supabase
    .from("backlink_credits")
    .select("amount")
    .eq("agency_id", agencyId);

  return (data ?? []).reduce((sum, row) => sum + row.amount, 0);
}

/**
 * Record a credit transaction.
 */
export async function recordCredit(
  supabase: SupabaseClient,
  agencyId: string,
  amount: number,
  reason: "host_link" | "place_link" | "bonus" | "adjustment",
  exchangeId?: string,
  drAtTime?: number | null,
): Promise<void> {
  const { error } = await supabase.from("backlink_credits").insert({
    agency_id: agencyId,
    amount,
    reason,
    exchange_id: exchangeId ?? null,
    // This column is the audit trail for why a trade cost what it cost. Writing
    // 0 for an unknown DR makes the ledger claim a reading that was never taken.
    dr_at_time: drAtTime ?? null,
  });

  if (error) throw new Error(error.message);
}

/**
 * Use AI to score relevance between an exchange request and a provider article.
 * Returns a 0-1 score.
 */
export async function scoreRelevance(
  articleTitle: string,
  articleKeyword: string,
  targetTopic: string,
  targetKeyword: string,
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 0.5; // Default score if no API key

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: anthropicModel("structured"),
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          `Rate the topical relevance (0.0 to 1.0) for placing a backlink about "${targetKeyword}" (topic: ${targetTopic}) `,
          `within an article titled "${articleTitle}" about "${articleKeyword}".`,
          `Reply with ONLY a decimal number between 0.0 and 1.0.`,
        ].join(""),
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "0.5";
  const score = parseFloat(text.trim());
  return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
}

/**
 * Suggest where in an article to contextually place a backlink.
 * Returns a suggestion object with paragraph index and anchor text.
 */
export async function suggestPlacement(
  articleHtml: string,
  targetUrl: string,
  targetKeyword: string,
): Promise<{ paragraphIndex: number; anchorText: string; context: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { paragraphIndex: 1, anchorText: targetKeyword, context: "" };
  }

  const client = new Anthropic({ apiKey });

  // Truncate HTML to avoid token limits
  const truncated = articleHtml.slice(0, 3000);

  const response = await client.messages.create({
    model: anthropicModel("structured"),
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          `Given this article HTML:\n${truncated}\n\n`,
          `Suggest where to naturally place a backlink to "${targetUrl}" about "${targetKeyword}".`,
          `Reply with JSON: {"paragraphIndex": <number>, "anchorText": "<text>", "context": "<surrounding sentence>"}`,
          `Reply with ONLY valid JSON.`,
        ].join(""),
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    return JSON.parse(text.replace(/^```json?\n?/, "").replace(/\n?```$/, ""));
  } catch {
    return { paragraphIndex: 1, anchorText: targetKeyword, context: "" };
  }
}

/**
 * Insert a backlink into an article's Tiptap JSON content.
 *
 * Finds the target paragraph by index, then appends a linked sentence
 * at the end of the paragraph. Returns the modified content, or the
 * original if insertion fails.
 */
export function insertBacklinkIntoContent(
  content: TiptapDoc,
  targetUrl: string,
  anchorText: string,
  paragraphIndex: number,
): TiptapDoc {
  if (!content.content || content.content.length === 0) return content;

  // Collect all paragraph nodes with their indices in the doc
  const paragraphs: { node: TiptapNode; docIndex: number }[] = [];
  for (let i = 0; i < content.content.length; i++) {
    if (content.content[i].type === "paragraph") {
      paragraphs.push({ node: content.content[i], docIndex: i });
    }
  }

  // Clamp to valid range
  const targetIdx = Math.max(0, Math.min(paragraphIndex, paragraphs.length - 1));
  const target = paragraphs[targetIdx];

  if (!target) return content;

  // Build the link node: " Learn more about <anchor text>."
  const linkNodes: TiptapNode[] = [
    { type: "text", text: " Learn more about " },
    {
      type: "text",
      text: anchorText,
      marks: [
        {
          type: "link",
          attrs: {
            href: targetUrl,
            target: "_blank",
            // Exchanged links are credit-compensated, so they MUST be nofollow +
            // sponsored (Google link-scheme compliance). Never emit them dofollow.
            rel: "noopener noreferrer nofollow sponsored",
          },
        },
      ],
    },
    { type: "text", text: "." },
  ];

  // Clone the doc to avoid mutation
  const newContent = content.content.map((node, i) => {
    if (i !== target.docIndex) return node;
    return {
      ...node,
      content: [...(node.content ?? []), ...linkNodes],
    };
  });

  return { type: "doc", content: newContent };
}

/**
 * Place a backlink in an article and update both the article and exchange in the DB.
 */
const VERIFY_UA =
  "Mozilla/5.0 (compatible; AltoRank-ExchangeVerifier/1.0; " +
  "+https://altorank.co; backlink placement verification)";

export type PlacementVerdict = {
  ok: boolean;
  /** The URL that was actually fetched, so a failure can be reproduced by hand. */
  url: string | null;
  httpStatus: number | null;
  /** rel attribute found on the matching anchor, verbatim. */
  rel: string | null;
  reason: string;
};

/** Same link, written differently: trailing slash, scheme, case. */
function sameTarget(href: string, target: string): boolean {
  const norm = (u: string) =>
    u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/#.*$/, "");
  return norm(href) === norm(target);
}

/**
 * Confirm a placed link is actually live on the public web.
 *
 * Credits used to move the moment a participant pressed a button: nothing ever
 * fetched the page. A provider could mark a link placed, collect the credits and
 * delete it, and the ledger would never notice. The cron comment promised that
 * "credit transfer must follow a real verification, not a timer" — this is the
 * verification that sentence assumed existed.
 *
 * Four things have to hold, and all four are things a reader or a crawler would
 * see: the page loads, it is indexable, the anchor is present, and it carries
 * the rel this network requires. A nofollow+sponsored link is the whole basis on
 * which this exchange is not a link scheme, so a placement that quietly went
 * dofollow is a failure, not a bonus.
 */
export async function verifyPlacementLive(
  pageUrl: string | null,
  targetUrl: string,
): Promise<PlacementVerdict> {
  if (!pageUrl) {
    return {
      ok: false,
      url: null,
      httpStatus: null,
      rel: null,
      reason:
        "the hosting article has no published URL, so the link is not on the web yet",
    };
  }

  let res: Response;
  try {
    res = await fetchSite(pageUrl, {
      headers: { "user-agent": VERIFY_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      url: pageUrl,
      httpStatus: null,
      rel: null,
      reason: `could not fetch the hosting page: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      url: pageUrl,
      httpStatus: res.status,
      rel: null,
      reason: `hosting page returned ${res.status}`,
    };
  }

  // A link on a page search engines are told to drop is worth nothing, and the
  // header form is invisible in the HTML, so both are checked.
  const xRobots = res.headers.get("x-robots-tag") ?? "";
  const html = await res.text();
  const metaRobots =
    html.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? "";
  if (/noindex/i.test(xRobots) || /noindex/i.test(metaRobots)) {
    return {
      ok: false,
      url: pageUrl,
      httpStatus: res.status,
      rel: null,
      reason: "hosting page is noindex, so the placement carries no value",
    };
  }

  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || !sameTarget(href, targetUrl)) continue;

    const rel = (tag.match(/rel=["']([^"']*)["']/i)?.[1] ?? "").toLowerCase();
    const missing = ["nofollow", "sponsored"].filter((t) => !rel.split(/\s+/).includes(t));
    if (missing.length) {
      return {
        ok: false,
        url: pageUrl,
        httpStatus: res.status,
        rel: rel || null,
        reason: `link found but rel is missing ${missing.join(" and ")} (found "${rel || "none"}")`,
      };
    }
    return {
      ok: true,
      url: pageUrl,
      httpStatus: res.status,
      rel,
      reason: "link is live, indexable and correctly marked nofollow sponsored",
    };
  }

  return {
    ok: false,
    url: pageUrl,
    httpStatus: res.status,
    rel: null,
    reason: "no link to the target URL found on the hosting page",
  };
}

/**
 * The decision half of settlement, kept pure so it can be tested without a
 * database or a live page.
 *
 * Two rules, and the first is the whole point of the redesign. Credits settle
 * because the host PUBLISHED the article, not because a link survived: if
 * payment depended on the link, the credits would have bought the link, which
 * is "exchanging goods or services for links" in Google's own words. The host
 * may cut the citation while editing and still be paid. That is what makes
 * this a content trade rather than a link purchase, and it is checkable here.
 *
 * The second rule is the old one and stays: an unmeasured host cannot be
 * priced, because settling at the cheapest tier would pay a strong host and a
 * worthless one the same.
 */
export type SettlementDecision =
  | { settle: true; credits: number }
  | { settle: false; reason: string };

export function settlementDecision(exchange: {
  status: string;
  provider_agency_id: string | null;
  requester_agency_id: string | null;
  provider_dr: number | null | undefined;
}): SettlementDecision {
  if (exchange.status !== "placed") {
    return { settle: false, reason: `exchange is ${exchange.status}, not placed` };
  }
  if (!exchange.provider_agency_id || !exchange.requester_agency_id) {
    return { settle: false, reason: "exchange has no provider or requester" };
  }
  const credits = creditsForDR(exchange.provider_dr);
  if (credits === null) {
    return {
      settle: false,
      reason: "the hosting site has no measured domain rating, so the trade cannot be priced",
    };
  }
  return { settle: true, credits };
}

export type SettlementOutcome =
  | { settled: true; credits: number; citation: "kept" | "removed"; detail: string }
  | { settled: false; reason: string };

/**
 * Settle the exchange an article belongs to, once that article is live.
 *
 * Called from the publish path for every article; almost every article belongs
 * to no exchange, so the first query is the fast exit. Needs the service role
 * and takes it rather than the caller's client: credits are written for two
 * different accounts, and RLS scopes a member to inserting their own.
 *
 * Whether the citation survived is recorded, never enforced. The requester is
 * owed the truth about what they got - a published article that cites them, or
 * a published article that no longer does - and both are honest outcomes of a
 * trade whose subject was the article.
 */
export async function settleExchangeForArticle(
  admin: SupabaseClient,
  articleId: string,
): Promise<SettlementOutcome | null> {
  const { data: exchange } = await admin
    .from("backlink_exchanges")
    .select("id, status, provider_agency_id, requester_agency_id, provider_workspace_id, target_url")
    .eq("provider_article_id", articleId)
    .maybeSingle();
  if (!exchange) return null;

  const { data: providerWs } = await admin
    .from("workspaces")
    .select("dr")
    .eq("id", exchange.provider_workspace_id)
    .maybeSingle();

  const decision = settlementDecision({
    status: exchange.status as string,
    provider_agency_id: exchange.provider_agency_id as string | null,
    requester_agency_id: exchange.requester_agency_id as string | null,
    provider_dr: providerWs?.dr as number | null | undefined,
  });
  if (!decision.settle) return { settled: false, reason: decision.reason };

  const { data: article } = await admin
    .from("articles")
    .select("published_url")
    .eq("id", articleId)
    .maybeSingle();

  // A report, not a gate.
  const verdict = await verifyPlacementLive(
    (article?.published_url as string | null) ?? null,
    exchange.target_url as string,
  );

  await recordCredit(admin, exchange.provider_agency_id as string, decision.credits, "host_link", exchange.id as string, providerWs?.dr as number | null);
  await recordCredit(admin, exchange.requester_agency_id as string, -decision.credits, "place_link", exchange.id as string, providerWs?.dr as number | null);

  await admin
    .from("backlink_exchanges")
    .update({
      status: "live",
      placement_url: (article?.published_url as string | null) ?? null,
      verified_at: new Date().toISOString(),
    })
    .eq("id", exchange.id);

  return {
    settled: true,
    credits: decision.credits,
    citation: verdict.ok ? "kept" : "removed",
    detail: verdict.reason,
  };
}

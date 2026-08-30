import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicModel } from "@/lib/ai/models";

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
 */
export function creditsForDR(dr: number): number {
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
  drAtTime?: number,
): Promise<void> {
  const { error } = await supabase.from("backlink_credits").insert({
    agency_id: agencyId,
    amount,
    reason,
    exchange_id: exchangeId ?? null,
    dr_at_time: drAtTime ?? 0,
  });

  if (error) throw new Error(error.message);
}

/**
 * Find matching exchange requests for a provider workspace.
 * Matches based on topic relevance and available credits.
 */
export async function findMatchingRequests(
  supabase: SupabaseClient,
  providerAgencyId: string,
  providerWorkspaceId: string,
): Promise<Array<{
  id: string;
  target_url: string;
  target_keyword: string;
  target_topic: string;
  credits_offered: number;
  requester_agency_id: string;
}>> {
  const { data } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .eq("status", "requested")
    .neq("requester_agency_id", providerAgencyId)
    .is("provider_agency_id", null)
    .order("credits_offered", { ascending: false })
    .limit(20);

  return (data ?? []).map((row) => ({
    id: row.id,
    target_url: row.target_url,
    target_keyword: row.target_keyword ?? "",
    target_topic: row.target_topic ?? "",
    credits_offered: row.credits_offered,
    requester_agency_id: row.requester_agency_id,
  }));
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
export async function placeBacklinkInArticle(
  supabase: SupabaseClient,
  exchangeId: string,
): Promise<void> {
  // Fetch exchange with placement suggestion
  const { data: exchange, error: exErr } = await supabase
    .from("backlink_exchanges")
    .select("*")
    .eq("id", exchangeId)
    .single();

  if (exErr || !exchange) throw new Error("Exchange not found");
  if (exchange.status !== "accepted") {
    throw new Error(`Cannot place link for exchange in status: ${exchange.status}`);
  }
  if (!exchange.provider_article_id) {
    throw new Error("No provider article assigned to this exchange");
  }

  // Fetch the article content
  const { data: article, error: artErr } = await supabase
    .from("articles")
    .select("id, content")
    .eq("id", exchange.provider_article_id)
    .single();

  if (artErr || !article?.content) throw new Error("Article not found or has no content");

  const placement = (exchange.suggested_placement as {
    paragraphIndex?: number;
    anchorText?: string;
  }) ?? {};

  const paragraphIndex = placement.paragraphIndex ?? 1;
  const anchorText = placement.anchorText ?? exchange.target_keyword ?? "this resource";

  // Insert the link
  const updatedContent = insertBacklinkIntoContent(
    article.content as TiptapDoc,
    exchange.target_url,
    anchorText,
    paragraphIndex,
  );

  // Update article content
  const { error: updateArticleErr } = await supabase
    .from("articles")
    .update({
      content: updatedContent,
      updated_at: new Date().toISOString(),
    })
    .eq("id", article.id);

  if (updateArticleErr) throw new Error(updateArticleErr.message);

  // Update exchange status to "placed"
  const { error: updateExErr } = await supabase
    .from("backlink_exchanges")
    .update({
      status: "placed",
      placed_at: new Date().toISOString(),
    })
    .eq("id", exchangeId);

  if (updateExErr) throw new Error(updateExErr.message);
}

// ---------------------------------------------------------------------------
// Ad copy generator: variations shaped to one platform's format
// ---------------------------------------------------------------------------
//
// Character limits are checked here, in code, never trusted to the prompt.
// Google's responsive search ad limits are hard (the ad account refuses a
// 31-character headline), so an over-limit line is marked "over" and left
// out of the count of usable lines. Meta and LinkedIn accept longer text but
// cut it in the feed, so there the check is a warning at the point where the
// "see more" fold usually falls.

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { kv, table, text, type Block, type KvItem } from "../blocks";
import { choice, optionalText, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "ad-copy-generator";

export const GOOGLE_HEADLINE_MAX = 30;
export const GOOGLE_DESCRIPTION_MAX = 90;

/** Feed-fold guidance for the social platforms: [field, shown before truncation, hard max]. */
export const SOCIAL_LIMITS = {
  meta: { primary: [125, 2200], headline: [40, 255], description: [30, 255] },
  linkedin: { primary: [150, 600], headline: [70, 200], description: [100, 300] },
} as const;

const GoogleAnswer = z.object({
  headlines: z.array(z.string().min(1)).min(3).max(20),
  descriptions: z.array(z.string().min(1)).min(2).max(6),
});
const SocialAnswer = z.object({
  variations: z
    .array(z.object({ primary: z.string().min(1), headline: z.string().min(1), description: z.string().default("") }))
    .min(1)
    .max(6),
});

const COMMON = [
  "Write only claims the product description supports. No invented prices, discounts, awards, statistics or guarantees. No all caps, no emoji, no exclamation-mark runs.",
  JSON_ONLY,
  INPUT_RULES,
];

const SYSTEM = {
  google: [
    "You write Google Ads responsive search ads.",
    "Write 15 headlines of at most 30 characters each (count every character, including spaces) and 4 descriptions of at most 90 characters each.",
    "Any headline can appear next to any other, so each must make sense on its own. Vary them: product, benefit, audience, proof from the description, call to action.",
    'Shape: {"headlines":["..."],"descriptions":["..."]}',
    ...COMMON,
  ].join("\n"),
  meta: [
    "You write Meta (Facebook and Instagram) feed ads.",
    "Write 4 variations. Each has primary text (the first 125 characters must carry the whole message; at most 300 characters in total), a headline (at most 40 characters) and a description (at most 30 characters).",
    'Shape: {"variations":[{"primary":"...","headline":"...","description":"..."}]}',
    ...COMMON,
  ].join("\n"),
  linkedin: [
    "You write LinkedIn sponsored content ads for a professional audience.",
    "Write 4 variations. Each has introductory text (the first 150 characters must carry the whole message; at most 400 characters in total), a headline (at most 70 characters) and a description (at most 100 characters).",
    'Shape: {"variations":[{"primary":"...","headline":"...","description":"..."}]}',
    ...COMMON,
  ].join("\n"),
};

function hardFit(s: string, max: number): string {
  const n = charLength(s);
  return n <= max ? "yes" : `over by ${n - max}`;
}

function softFit(s: string, fold: number, max: number): string {
  const n = charLength(s);
  if (n > max) return `over the ${max} limit`;
  return n <= fold ? "yes" : `cut after ${fold}`;
}

export const adCopyGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    product: requiredText("the product or service", 600),
    audience: optionalText("the audience", 200),
    platform: choice(["google", "meta", "linkedin"] as const, "google", "platform"),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 0.8,
  async run({ product, audience, platform }, ctx) {
    const user = [tagged("product", product), audience ? tagged("audience", audience) : ""].filter(Boolean).join("\n");
    const blocks: Block[] = [];

    if (platform === "google") {
      const { data } = await askHaikuJson({
        tool: SLUG,
        system: SYSTEM.google,
        user,
        maxTokens: 900,
        temperature: 0.8,
        schema: GoogleAnswer,
        signal: ctx.signal,
      });
      const headlines = data.headlines.slice(0, 15);
      const descriptions = data.descriptions.slice(0, 4);
      const okH = headlines.filter((h) => charLength(h) <= GOOGLE_HEADLINE_MAX).length;
      const okD = descriptions.filter((d) => charLength(d) <= GOOGLE_DESCRIPTION_MAX).length;
      const summary: KvItem[] = [
        { label: "Headlines within 30 characters", value: `${okH} of ${headlines.length}`, status: okH === headlines.length ? "pass" : "warn" },
        { label: "Descriptions within 90 characters", value: `${okD} of ${descriptions.length}`, status: okD === descriptions.length ? "pass" : "warn" },
      ];
      blocks.push(kv(summary, "Google responsive search ad"));
      blocks.push(table(["Headline", "Characters", "Fits 30"], headlines.map((h) => [h, charLength(h), hardFit(h, GOOGLE_HEADLINE_MAX)]), "Headlines"));
      blocks.push(
        table(["Description", "Characters", "Fits 90"], descriptions.map((d) => [d, charLength(d), hardFit(d, GOOGLE_DESCRIPTION_MAX)]), "Descriptions"),
      );
      if (okH < headlines.length || okD < descriptions.length) {
        blocks.push(text("Lines marked \"over\" will be refused by Google Ads as written. Shorten them before you paste them in.", "Over the limit"));
      }
    } else {
      const limits = SOCIAL_LIMITS[platform];
      const { data } = await askHaikuJson({
        tool: SLUG,
        system: SYSTEM[platform],
        user,
        maxTokens: 1100,
        temperature: 0.8,
        schema: SocialAnswer,
        signal: ctx.signal,
      });
      const rows = data.variations.map((v, i) => [
        i + 1,
        v.primary,
        softFit(v.primary, limits.primary[0], limits.primary[1]),
        v.headline,
        softFit(v.headline, limits.headline[0], limits.headline[1]),
        v.description,
      ]);
      const label = platform === "meta" ? "Meta (Facebook and Instagram)" : "LinkedIn";
      blocks.push(
        table(
          ["#", "Primary text", `Before the fold (${limits.primary[0]})`, "Headline", `Headline fits (${limits.headline[0]})`, "Description"],
          rows,
          `${label} variations`,
        ),
      );
      blocks.push(
        text(
          `${label} shows about the first ${limits.primary[0]} characters of the primary text before "see more", depending on placement and device. Make sure that part carries the message.`,
          "Feed truncation",
        ),
      );
    }

    blocks.push(
      text(
        "Drafts from your description only. The model has not seen your landing page and does not check ad policies, so check every claim and the platform's rules before anything goes live.",
        "Before you publish",
      ),
    );
    return blocks;
  },
});

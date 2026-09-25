// ---------------------------------------------------------------------------
// Social media post generator: posts for X, LinkedIn or Instagram
// ---------------------------------------------------------------------------
//
// Platform limits are checked here, in code. X is counted the way X counts:
// most CJK characters and emoji weigh 2, a link weighs 23. A post over a hard
// limit is marked, not silently cut: cutting would change what it says.
//
// Pasted text is not cached (cacheTtlMs: 0).

import { z } from "zod";
import { defineTool } from "../types";
import { askHaikuJson } from "../ai";
import { code, kv, text, type Block, type KvItem } from "../blocks";
import { choice, requiredText } from "../fields";
import { INPUT_RULES, JSON_ONLY, charLength, tagged } from "../prompt";

const SLUG = "social-media-post-generator";

export const PLATFORMS = {
  x: { label: "X", max: 280, fold: 280, hashtags: 2 },
  linkedin: { label: "LinkedIn", max: 3000, fold: 210, hashtags: 3 },
  instagram: { label: "Instagram", max: 2200, fold: 125, hashtags: 30 },
} as const;
type Platform = keyof typeof PLATFORMS;

/** X's weighted length: links 23, most characters outside Latin/common punctuation 2. */
export function xLength(post: string): number {
  let n = 0;
  const withoutUrls = post.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    const light =
      cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

export function postLength(post: string, platform: Platform): number {
  return platform === "x" ? xLength(post) : charLength(post);
}

const Answer = z.object({ posts: z.array(z.object({ text: z.string().min(1) })).min(1).max(5) });

const GUIDE: Record<Platform, string> = {
  x: "X: each post at most 250 characters so it fits 280 after edits, links counted as 23. One idea per post. At most 2 hashtags, only if they help.",
  linkedin:
    "LinkedIn: 600 to 1,300 characters. The first two lines (about 200 characters) must make someone click 'see more'. Short paragraphs, line breaks between them. At most 3 hashtags, at the end.",
  instagram:
    "Instagram caption: 300 to 1,000 characters. The first 125 characters carry the message. Line breaks between short paragraphs. 3 to 8 relevant hashtags at the end.",
};

function system(platform: Platform): string {
  return [
    "You write social media posts.",
    "The visitor gives either a topic or a passage from something they published. Write 3 distinct posts for the platform below: different hooks, the same substance. If they gave a passage, stay faithful to it and do not add facts.",
    GUIDE[platform],
    "No engagement bait ('comment YES'), no invented statistics, no emoji walls (at most 2 emoji per post).",
    'Shape: {"posts":[{"text":"..."}]}',
    JSON_ONLY,
    INPUT_RULES,
  ].join("\n");
}

export const socialMediaPostGenerator = defineTool({
  slug: SLUG,
  kind: "ai",
  input: z.object({
    topic_or_text: requiredText("a topic or some text", 5000),
    platform: choice(["linkedin", "x", "instagram"] as const, "linkedin", "platform"),
  }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  estimateCents: 1,
  cacheTtlMs: 0,
  async run({ topic_or_text, platform }, ctx) {
    const spec = PLATFORMS[platform];
    const { data } = await askHaikuJson({
      tool: SLUG,
      system: system(platform),
      user: tagged("material", topic_or_text),
      maxTokens: 1400,
      temperature: 0.8,
      schema: Answer,
      signal: ctx.signal,
    });

    const items: KvItem[] = [];
    const blocks: Block[] = [];
    data.posts.forEach((p, i) => {
      const len = postLength(p.text, platform);
      const tags = (p.text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
      const problems: string[] = [];
      if (len > spec.max) problems.push(`${len - spec.max} over the ${spec.max} limit`);
      if (platform === "instagram" && tags > spec.hashtags) problems.push(`${tags} hashtags; Instagram allows ${spec.hashtags}`);
      const folded = len > spec.fold && len <= spec.max && platform !== "x";
      items.push({
        label: `Post ${i + 1}`,
        value: problems.length
          ? problems.join("; ")
          : `${len} of ${spec.max} characters${folded ? `; about the first ${spec.fold} show before "see more"` : ""}`,
        status: problems.length ? "fail" : "pass",
      });
      blocks.push(code(p.text, "text", `Post ${i + 1} · ${len} / ${spec.max}`));
    });

    return [
      kv(items, `${spec.label} length check`),
      ...blocks,
      text(
        `${platform === "x" ? "Lengths are counted the way X counts (links as 23, most emoji as 2). " : ""}Recount after you edit, add your own voice, and check any claim before you post. The tool writes text only: it does not post, schedule or make images.`,
        "Before you post",
      ),
    ];
  },
});

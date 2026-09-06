// ---------------------------------------------------------------------------
// Meta Description Generator pipeline
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { buildMetaPrompt } from "@/lib/ai/meta-prompt";
import type { MetaDescriptionResult, MetaVariant } from "./types";

import { anthropicModel } from "@/lib/ai/models";
import { fetchSite } from "@/lib/audit/lenient-fetch";

export async function generateMetaDescriptions(
  keyword: string,
  url?: string,
): Promise<MetaDescriptionResult> {
  // If a URL is provided, fetch the page content for context
  let pageContent: string | undefined;
  if (url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetchSite(url, {
        signal: controller.signal,
        headers: { "User-Agent": "AltoRank-MetaTool/1.0" },
      });
      clearTimeout(timeout);
      if (res.ok) {
        const html = await res.text();
        // Extract text content — strip tags for prompt context
        pageContent = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    } catch {
      // Continue without page content
    }
  }

  const { system, user } = buildMetaPrompt(keyword, url, pageContent);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: anthropicModel("structured"),
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);

  const variants: MetaVariant[] = Array.isArray(parsed.variants)
    ? parsed.variants.map((v: Record<string, unknown>) => ({
        text: String(v.text ?? ""),
        charCount: Number(v.charCount ?? String(v.text ?? "").length),
        style: String(v.style ?? ""),
      }))
    : [];

  return { keyword, url, variants };
}

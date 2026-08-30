// ---------------------------------------------------------------------------
// Claude prompt builder for SERP analysis insights
// ---------------------------------------------------------------------------

import type { SerpAnalysisItem } from "@/lib/tools/types";

const SYSTEM_PROMPT = `You are an expert SEO analyst. Given SERP data for a keyword, provide a brief analysis of the search landscape.

Your output MUST be a single string (not JSON) — 3-5 sentences covering:
1. What type of content dominates (guides, listicles, product pages, etc.)
2. Average content depth and what that signals
3. Key patterns or gaps in the top results
4. Actionable recommendation for someone trying to rank

Keep it concise and specific — no generic advice. Reference actual patterns from the data.`;

export function buildSerpInsightsPrompt(
  keyword: string,
  results: SerpAnalysisItem[],
  peopleAlsoAsk: string[],
): { system: string; user: string } {
  const parts: string[] = [`Keyword: "${keyword}"\n`];

  parts.push("## Top 10 Results\n");
  for (const r of results) {
    const wc = r.wordCount ? ` | ~${r.wordCount} words` : "";
    parts.push(`${r.position}. **${r.title}** (${r.domain}${wc})`);
    if (r.description) parts.push(`   ${r.description}`);
  }

  if (peopleAlsoAsk.length > 0) {
    parts.push("\n## People Also Ask\n");
    for (const q of peopleAlsoAsk) {
      parts.push(`- ${q}`);
    }
  }

  parts.push(
    "\nProvide your SERP analysis as plain text (not JSON, not markdown). 3-5 sentences.",
  );

  return { system: SYSTEM_PROMPT, user: parts.join("\n") };
}

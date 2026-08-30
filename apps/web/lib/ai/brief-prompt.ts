// ---------------------------------------------------------------------------
// Claude prompt builder for Content Brief generation
// ---------------------------------------------------------------------------

import type { SerpData, RelatedKeyword } from "@/lib/seo/brief-data";

const SYSTEM_PROMPT = `You are an expert SEO content strategist. Given SERP competitor data and related keywords for a target keyword, produce a comprehensive content brief in JSON format.

Your output MUST be valid JSON matching this exact shape — no markdown, no code fences, no explanation:

{
  "title": "string — suggested H1/title tag, compelling + keyword-inclusive",
  "metaDescription": "string — 150-160 chars, action-oriented, includes keyword",
  "outline": [
    {
      "h2": "string — section heading",
      "h3s": ["string — subsection headings"],
      "keyPoints": ["string — key points to cover in this section"]
    }
  ],
  "lsiKeywords": [
    {
      "keyword": "string",
      "searchVolume": number | null,
      "competition": number | null
    }
  ],
  "faqs": [
    {
      "question": "string — natural question",
      "answer": "string — concise 2-3 sentence answer"
    }
  ],
  "wordCountTarget": number,
  "competitorInsights": "string — 2-3 sentence summary of what top competitors cover and where gaps exist"
}

Guidelines:
- Outline should have 4-8 H2 sections with practical, specific headings (not generic filler)
- Include H3s only where a section genuinely needs sub-topics
- Key points should be actionable and specific to the topic
- LSI keywords: pick the 10-15 most relevant from the provided list, prefer those with higher search volume
- FAQs: include 4-6, drawn from "People Also Ask" data when available, plus topic-relevant questions
- Word count target: base on competitor average, rounded up slightly (aim to be comprehensive)
- Competitor insights: what do top results do well? What angles are they missing?`;

export function buildBriefPrompt(
  keyword: string,
  serpData: SerpData | null,
  relatedKeywords: RelatedKeyword[],
): { system: string; user: string } {
  const parts: string[] = [`Target keyword: "${keyword}"\n`];

  if (serpData && serpData.organic.length > 0) {
    parts.push("## Top SERP Competitors\n");
    for (const item of serpData.organic) {
      const wc = item.wordCount ? ` | ~${item.wordCount} words` : "";
      parts.push(`- **${item.title}** (${item.domain}${wc})`);
      if (item.description) parts.push(`  ${item.description}`);
    }
    parts.push("");
  }

  if (serpData && serpData.peopleAlsoAsk.length > 0) {
    parts.push("## People Also Ask\n");
    for (const q of serpData.peopleAlsoAsk) {
      parts.push(`- ${q}`);
    }
    parts.push("");
  }

  if (relatedKeywords.length > 0) {
    parts.push("## Related Keywords (LSI candidates)\n");
    for (const kw of relatedKeywords) {
      const vol = kw.searchVolume != null ? ` | vol: ${kw.searchVolume}` : "";
      const comp =
        kw.competition != null
          ? ` | comp: ${(kw.competition * 100).toFixed(0)}%`
          : "";
      parts.push(`- ${kw.keyword}${vol}${comp}`);
    }
    parts.push("");
  }

  parts.push(
    "Generate the content brief as a single JSON object. No markdown fencing.",
  );

  return {
    system: SYSTEM_PROMPT,
    user: parts.join("\n"),
  };
}

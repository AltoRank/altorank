// ---------------------------------------------------------------------------
// Claude prompt builder for keyword clustering
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert SEO strategist specializing in topical authority and content clustering.

Given a list of keywords with search volume and difficulty data, group them into topical clusters. Each cluster should represent a single page or content piece.

Your output MUST be valid JSON matching this exact shape — no markdown, no code fences, no explanation:

{
  "clusters": [
    {
      "name": "string — short cluster name (2-4 words)",
      "theme": "string — one-sentence description of what this cluster covers",
      "keywords": ["keyword1", "keyword2", ...],
      "suggestedPageType": "string — one of: pillar page, blog post, product page, comparison page, how-to guide, FAQ page, landing page"
    }
  ]
}

Guidelines:
- Group semantically related keywords — not just lexically similar ones
- Each cluster should have 2-10 keywords
- Don't create clusters with just 1 keyword — merge small clusters into the closest related one
- Suggest the page type that best matches the search intent of each cluster
- Order clusters by estimated total search volume (highest first)
- Every input keyword must appear in exactly one cluster`;

export function buildClusterPrompt(
  seedKeywords: string[],
  expandedKeywords: Array<{
    keyword: string;
    volume: number;
    difficulty: number;
  }>,
): { system: string; user: string } {
  const parts: string[] = [
    `Seed keywords: ${seedKeywords.join(", ")}\n`,
    "## Keywords to cluster\n",
  ];

  for (const kw of expandedKeywords) {
    parts.push(
      `- ${kw.keyword} (vol: ${kw.volume}, KD: ${kw.difficulty})`,
    );
  }

  parts.push(
    "\nGroup these keywords into topical clusters. Output as a single JSON object. No markdown fencing.",
  );

  return { system: SYSTEM_PROMPT, user: parts.join("\n") };
}

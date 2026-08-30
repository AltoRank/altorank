// ---------------------------------------------------------------------------
// Claude prompt builder for Meta Description generation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert SEO copywriter. Generate compelling meta descriptions optimized for click-through rate.

Your output MUST be valid JSON matching this exact shape — no markdown, no code fences, no explanation:

{
  "variants": [
    {
      "text": "string — the meta description, 150-160 characters",
      "charCount": number,
      "style": "string — the writing style used"
    }
  ]
}

Generate exactly 5 variants, each with a different style:
1. Benefit-driven — leads with the value proposition
2. Question-based — opens with a question to spark curiosity
3. Action-oriented — starts with a verb/CTA
4. Statistics/proof — includes a number or data point (can be hypothetical but realistic)
5. Urgency/FOMO — creates time sensitivity or exclusivity

Guidelines:
- Each variant MUST be 150-160 characters (count carefully)
- Naturally include the target keyword or a close variation
- Write for humans, not search engines — compelling copy that earns clicks
- Avoid generic filler ("Learn more", "Click here", "Read on")
- Each variant should feel distinct, not a rephrase of the same sentence`;

export function buildMetaPrompt(
  keyword: string,
  url?: string,
  pageContent?: string,
): { system: string; user: string } {
  const parts: string[] = [`Target keyword: "${keyword}"\n`];

  if (url) {
    parts.push(`Target URL: ${url}\n`);
  }

  if (pageContent) {
    parts.push("## Page context\n");
    parts.push(pageContent.slice(0, 2000));
    parts.push("\n");
  }

  parts.push(
    "Generate 5 meta description variants as a single JSON object. No markdown fencing.",
  );

  return {
    system: SYSTEM_PROMPT,
    user: parts.join("\n"),
  };
}

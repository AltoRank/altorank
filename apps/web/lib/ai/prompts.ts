import type { ArticlePrompt } from "./types";
import type { ArticleResearch } from "@/lib/seo/research";
import { INTENT_GUIDANCE } from "@/lib/seo/intent";

// ---------------------------------------------------------------------------
// Build the system prompt sent to the AI model for article generation.
// ---------------------------------------------------------------------------

/**
 * Render the research bundle as prompt sections.
 *
 * Only renders layers that actually loaded. A layer that failed contributes
 * nothing rather than a placeholder, because "no competitor mentions X" and "we
 * could not read the competitors" lead the model to opposite conclusions and
 * only one of them is knowable here.
 *
 * Exported for testing: the exact wording of these sections is the difference
 * between a research-informed article and a generic one.
 */
export function buildResearchSection(research: ArticleResearch): string[] {
  const sections: string[] = [];

  // --- Intent ----------------------------------------------------------------
  const { intent, confidence, signals } = research.intent;
  const intentLines = [
    "SEARCH INTENT:",
    `- Classified as ${intent} (${confidence} confidence).`,
    `- ${INTENT_GUIDANCE[intent]}`,
  ];
  const topSignals = signals.filter((s) => s.weight > 0).slice(0, 3);
  if (topSignals.length) {
    intentLines.push(`- Evidence: ${topSignals.map((s) => s.reason).join("; ")}.`);
  }
  if (confidence === "low") {
    intentLines.push(
      "- Confidence is low, so favour a structure that serves more than one intent: " +
        "answer the question directly first, then cover the practical detail.",
    );
  }
  sections.push(intentLines.join("\n"));

  // --- What already ranks ----------------------------------------------------
  if (research.competitors.length) {
    const lines = [
      "WHAT CURRENTLY RANKS FOR THIS KEYWORD:",
      "These are the pages you must be more useful than. Use them to understand " +
        "what the reader expects to find and what has already been said. Do NOT " +
        "copy their wording, their structure, or their claims.",
      "",
    ];
    research.competitors.slice(0, 10).forEach((c, i) => {
      const wc = c.wordCount ? `, ~${c.wordCount} words` : "";
      lines.push(`${i + 1}. "${c.title}" (${c.domain}${wc})`);
      if (c.description) lines.push(`   ${c.description}`);
    });
    lines.push(
      "",
      "Find the angle these pages miss or cover thinly, and make that the part " +
        "of the article that earns the ranking.",
    );
    sections.push(lines.join("\n"));
  }

  // --- Questions to answer ---------------------------------------------------
  if (research.peopleAlsoAsk.length) {
    sections.push(
      [
        "QUESTIONS SEARCHERS ASK (from People Also Ask):",
        "Answer each of these somewhere in the article, using the question " +
          "wording as an H2 or H3 where it reads naturally. Each answer should " +
          "be self-contained enough to stand alone as a featured snippet.",
        "",
        ...research.peopleAlsoAsk.slice(0, 10).map((q) => `- ${q}`),
      ].join("\n"),
    );
  }

  // --- Terms to cover --------------------------------------------------------
  const worthCovering = research.relatedKeywords
    .filter((k) => (k.searchVolume ?? 0) > 0)
    .slice(0, 20);
  if (worthCovering.length) {
    sections.push(
      [
        "RELATED TERMS TO COVER NATURALLY:",
        "These are real queries with search demand. Work the relevant ones in " +
          "where they genuinely belong. Do not force every term, and never list " +
          "them: forced keyword insertion is the clearest signal of machine-written text.",
        "",
        ...worthCovering.map(
          (k) => `- ${k.keyword}${k.searchVolume ? ` (${k.searchVolume}/mo)` : ""}`,
        ),
      ].join("\n"),
    );
  }

  // --- What the site already earns -------------------------------------------
  if (research.existingPerformance) {
    const p = research.existingPerformance;
    sections.push(
      [
        "THIS SITE ALREADY RANKS FOR THIS QUERY:",
        `- Position ${p.position}, ${p.impressions} impressions and ${p.clicks} clicks over the last 90 days.`,
        p.position <= 20
          ? "- This is a page-one-adjacent position, so this article competes with " +
            "an existing page. Write something materially better and more specific, " +
            "not a near-duplicate that will split the ranking."
          : "- The site is visible but ranking poorly, which usually means the " +
            "existing coverage is thin or off-intent. Go deeper than a general overview.",
      ].join("\n"),
    );
  }

  if (research.adjacentQueries.length) {
    sections.push(
      [
        "QUERIES THIS SITE ALREADY GETS IMPRESSIONS FOR:",
        "Real demand this audience already shows. Cover these where they fit the article.",
        "",
        ...research.adjacentQueries
          .slice(0, 10)
          .map(
            (q) =>
              `- ${q.query} (position ${q.position}, ${q.impressions} impressions)`,
          ),
      ].join("\n"),
    );
  }

  return sections;
}

export function buildSystemPrompt(prompt: ArticlePrompt): string {
  const {
    keyword,
    title,
    voiceRules,
    language = "English",
    research,
  } = prompt;

  // An explicit target wins; otherwise use the length derived from what ranks.
  const targetWordCount =
    prompt.targetWordCount ?? research?.recommendedWordCount ?? 1500;

  const sections: string[] = [];

  // --- Role ------------------------------------------------------------------
  sections.push(
    `You are an expert SEO content writer. Your task is to write a comprehensive, ` +
      `well-structured article optimized for the keyword "${keyword}" in ${language}.`
  );

  // --- Title -----------------------------------------------------------------
  if (title) {
    sections.push(`Use the following title for the article:\n${title}`);
  } else {
    sections.push(
      `Generate a compelling, SEO-optimized title that naturally includes the keyword "${keyword}".`
    );
  }

  // --- Length -----------------------------------------------------------------
  sections.push(
    `Target approximately ${targetWordCount} words. ` +
      (research
        ? `This length is derived from the live SERP: ${research.wordCountBasis}. `
        : "") +
      `Ensure the content is thorough and provides genuine value to the reader. ` +
      `Do not pad to reach the target: stop when the topic is covered.`
  );

  // --- Research --------------------------------------------------------------
  // Placed before the format and SEO rules so the model has the subject matter
  // in hand before it is told how to lay it out.
  if (research) {
    sections.push(...buildResearchSection(research));
  }

  // --- Structure -------------------------------------------------------------
  sections.push(
    [
      "FORMAT & STRUCTURE REQUIREMENTS:",
      "- Output valid HTML only. Do NOT wrap it in markdown fences or add any preamble.",
      "- Start with a single <h1> tag containing the article title.",
      "- Use <h2> tags for major sections (aim for 4-8 sections).",
      "- Use <h3> tags for subsections where appropriate.",
      "- Use <p> tags for paragraphs. Keep paragraphs concise (2-4 sentences).",
      "- Use <ul>/<ol> and <li> for lists when they improve readability.",
      "- Use <strong> and <em> for emphasis where natural.",
      "- Do NOT include <html>, <head>, <body>, or <style> tags.",
    ].join("\n")
  );

  // --- SEO -------------------------------------------------------------------
  sections.push(
    [
      "SEO REQUIREMENTS:",
      `- Include the keyword "${keyword}" naturally in the H1, at least one H2, and in the first paragraph.`,
      "- Use semantic variations and related terms throughout.",
      "- Write a meta description (max 160 characters) that includes the keyword. " +
        'Output it as the very last line wrapped in: <meta-description>...</meta-description>',
      "- Add internal link placeholders where relevant using: " +
        '<a href="{{internal-link:related-topic}}">anchor text</a>',
      "- Structure content for featured snippets (clear definitions, numbered steps, tables).",
    ].join("\n")
  );

  // --- Voice rules -----------------------------------------------------------
  if (voiceRules) {
    const parts: string[] = ["VOICE & STYLE RULES:"];

    if (voiceRules.toneArchetype) {
      parts.push(`- Tone archetype: ${voiceRules.toneArchetype}`);
    } else if (voiceRules.tone) {
      parts.push(`- Tone: ${voiceRules.tone}`);
    }

    if (voiceRules.formalityLevel) {
      parts.push(`- Formality: ${voiceRules.formalityLevel}`);
    }

    if (voiceRules.sentenceRhythm) {
      parts.push(`- Sentence rhythm: ${voiceRules.sentenceRhythm}`);
    }

    if (voiceRules.emotionalRegister) {
      parts.push(`- Emotional register: ${voiceRules.emotionalRegister}`);
    }

    if (voiceRules.technicalDepth) {
      parts.push(`- Technical depth: ${voiceRules.technicalDepth}`);
    }

    if (voiceRules.audienceAwareness) {
      parts.push(`- Target audience: ${voiceRules.audienceAwareness}`);
    }

    if (voiceRules.vocabulary?.length) {
      parts.push(
        `- Preferred vocabulary: ${voiceRules.vocabulary.join(", ")}`
      );
    }

    if (voiceRules.signaturePhrases?.length) {
      parts.push(
        `- Signature phrases to use naturally: ${voiceRules.signaturePhrases.join("; ")}`
      );
    }

    if (voiceRules.writingPatterns?.length) {
      parts.push(
        `- Writing patterns to follow: ${voiceRules.writingPatterns.join("; ")}`
      );
    }

    if (voiceRules.avoidPatterns?.length) {
      parts.push(
        `- AVOID these patterns / words: ${voiceRules.avoidPatterns.join(", ")}`
      );
    }

    if (voiceRules.tags?.length) {
      parts.push(`- Content tags / themes: ${voiceRules.tags.join(", ")}`);
    }

    sections.push(parts.join("\n"));
  }

  // --- Factual discipline ----------------------------------------------------
  // The prevention half of fact-checking; lib/ai/fact-check.ts is the detection
  // half. Prevention is much cheaper: a statistic invented here has to be
  // caught, shown to a reviewer and removed, and if it is missed it ships.
  sections.push(
    [
      "FACTUAL CLAIMS:",
      "- Do NOT invent statistics, percentages, survey results, dates, prices, " +
        "or study findings. A plausible-sounding number you cannot attribute is " +
        "the single most damaging thing you can put in this article.",
      "- When you do cite a figure, name the source inline in the sentence " +
        '(for example: "according to the 2024 HTTP Archive Web Almanac"). ' +
        "Every unattributed figure is flagged for human review before publishing.",
      "- Do not attribute claims to named companies, people or publications " +
        "unless the claim is genuinely theirs.",
      "- Prefer a qualitative statement you know to be true over a quantitative " +
        'one you are guessing at. "Most sites get this wrong" is publishable; ' +
        '"73% of sites get this wrong" is not, unless you can name the source.',
      "- If the topic genuinely needs a figure you do not have, write the " +
        "sentence without it rather than filling the gap.",
    ].join("\n"),
  );

  // --- Final instructions ----------------------------------------------------
  sections.push(
    [
      "IMPORTANT:",
      "- Write for humans first, search engines second.",
      "- Avoid filler sentences and generic intros.",
      "- Every paragraph should deliver value.",
      "- Do NOT include any text outside of the HTML output and the meta-description tag.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

import type { ArticlePrompt } from "./types";
import type { ArticleResearch } from "@/lib/seo/research";
import { INTENT_GUIDANCE } from "@/lib/seo/intent";
import { LENGTH_BANDS, TAXONOMY_LABELS, targetWordCountFor } from "@/lib/keywords/taxonomy";

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
      // Rank comes from the SERP, so number by it rather than by array order:
      // "the page at #1" is a different instruction from "the first one listed".
      const pos = typeof c.rank === "number" ? `#${c.rank}` : `${i + 1}.`;
      lines.push(`${pos} "${c.title}" (${c.domain}${wc})`);
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

  // --- What Google's AI answer already says ----------------------------------
  //
  // The single most direct evidence available of what an AI answer contains for
  // this query and which pages it trusts. It arrives in the SERP response we
  // already pay for and used to be discarded. Being cited means adding something
  // this block does not already have, so the model is told what it says rather
  // than left to guess.
  if (research.aiOverview) {
    const ao = research.aiOverview;
    const lines = [
      "GOOGLE'S AI OVERVIEW FOR THIS QUERY:",
      "This is the answer Google already shows above the results. To be cited " +
        "instead of these sources, the article has to add something this does " +
        "not have: a specific number, a first-hand test, a case it does not " +
        "cover, or a sharper answer to the same question. Do not restate it.",
      "",
      ao.markdown.slice(0, 2000),
    ];
    if (ao.citations.length) {
      lines.push(
        "",
        `Sources this AI Overview cites (${ao.citations.length}) — these are the ` +
          "pages to displace:",
        ...ao.citations.slice(0, 10).map((c) => `- ${c.domain}: ${c.title}`),
      );
    }
    sections.push(lines.join("\n"));
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

/**
 * The register that reads as machine-written, as a list.
 *
 * The prompt below bans these in prose; lib/refresh/validate.ts checks a
 * rewrite against the same list so the check and the instruction cannot
 * drift apart. Lower-case, matched as substrings of the page text.
 */
export const BANNED_PHRASES: readonly string[] = [
  "in today's fast-paced world",
  "in the ever-evolving landscape",
  "in the digital age",
  "let's dive in",
  "look no further",
  "delve",
  "tapestry",
  "unlock the power",
  "game-changer",
  "robust solution",
  "seamlessly",
  "it is important to note that",
  "in conclusion",
];

/**
 * The user turn. One place, so both providers say the same thing and a
 * refresh asks for a rewrite rather than a fresh article.
 */
export function buildUserMessage(prompt: ArticlePrompt): string {
  if (prompt.refreshOf) {
    return `Rewrite the existing page now, following the brief, for the keyword: "${prompt.keyword}"`;
  }
  return `Write the article now for the keyword: "${prompt.keyword}"`;
}

/**
 * The section that turns the article brief into a rewrite brief.
 *
 * Placed right after the role so the model reads "this page exists" before it
 * reads the format rules, which otherwise describe a blank page. The body is
 * capped because a refresh of a very long page still has to leave room for
 * the output; the cap is generous enough that nothing normal is cut.
 */
export function buildRefreshSection(refresh: NonNullable<ArticlePrompt["refreshOf"]>): string[] {
  const MAX_BODY = 60_000;
  const body =
    refresh.existingHtml.length > MAX_BODY
      ? refresh.existingHtml.slice(0, MAX_BODY) + "\n<!-- truncated for length -->"
      : refresh.existingHtml;
  const { current, max } = refreshLengthBudget(refresh.existingHtml);
  return [
    [
      "THIS IS A REWRITE OF AN EXISTING PAGE, NOT A NEW ARTICLE.",
      `- The page is about ${current.toLocaleString()} words. The rewrite must stay under ` +
        `${max.toLocaleString()} words. This cap wins over the brief: if the brief asks for more ` +
        "than fits, sharpen existing sections instead of adding new ones, and add at most two " +
        "new sections. The first run of this prompt without a cap produced a page that could " +
        "not finish.",
      refresh.url ? `- The page lives at ${refresh.url}.` : "",
      refresh.title ? `- Its current title is: ${refresh.title}` : "",
      refresh.metaDescription ? `- Its current meta description is: ${refresh.metaDescription}` : "",
      "- Preserve the section order and every H2 that already addresses the topic. Strengthen",
      "  headings that are vague; do not rename ones that are already the question a reader types.",
      "- Keep every existing link exactly as it is (same href, same anchor unless the sentence",
      "  around it changes) and every image (same src and alt). Removing a link or an image",
      "  is a regression, not an edit.",
      "- Refresh facts, figures, prices and dates that have aged. Do not invent replacements:",
      "  a figure you cannot source is cut, not updated.",
      "- Improve coverage where the brief says the page is thin, and add the questions the",
      "  brief lists as their own H2 or H3 with a self-contained answer.",
      "- Write a stronger title and meta description if the brief asks for it; otherwise keep",
      "  them close to the current ones.",
      "- Keep paragraphs that are already good. The reviewer sees a block-by-block diff, and",
      "  a rewrite that rewords every sentence for no reason is harder to trust than one",
      "  that changes what needed changing.",
    ]
      .filter(Boolean)
      .join("\n"),
    ["THE BRIEF FOR THIS REWRITE:", refresh.brief.trim()].join("\n"),
    ["THE CURRENT PAGE BODY (HTML):", body].join("\n"),
  ];
}

/**
 * How long a rewrite may get: the current length plus a third, floored so a
 * very short page can still be brought up to a useful size.
 */
export function refreshLengthBudget(existingHtml: string): { current: number; max: number } {
  const current = existingHtml.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
  return { current, max: Math.max(900, Math.round(current * 1.3)) };
}

export function buildSystemPrompt(prompt: ArticlePrompt): string {
  const {
    keyword,
    title,
    voiceRules,
    language = "English",
    research,
  } = prompt;

  // An explicit target wins; then the owner's length band for this keyword;
  // otherwise the length derived from what ranks.
  const band =
    prompt.brief?.expectedLength && prompt.brief.expectedLength !== "auto" && prompt.brief.expectedLength in LENGTH_BANDS
      ? LENGTH_BANDS[prompt.brief.expectedLength as keyof typeof LENGTH_BANDS]
      : null;
  const targetWordCount =
    prompt.targetWordCount ??
    targetWordCountFor(prompt.brief?.expectedLength, research?.recommendedWordCount) ??
    1500;

  const sections: string[] = [];

  // --- Role ------------------------------------------------------------------
  sections.push(
    prompt.refreshOf
      ? `You are an expert SEO editor. Your task is to rewrite an existing, well-structured ` +
          `page so it ranks and converts better for the keyword "${keyword}" in ${language}, ` +
          `changing what the brief says needs changing and keeping the rest.`
      : `You are an expert SEO content writer. Your task is to write a comprehensive, ` +
          `well-structured article optimized for the keyword "${keyword}" in ${language}.`
  );

  // --- The page being rewritten ---------------------------------------------
  if (prompt.refreshOf) {
    sections.push(...buildRefreshSection(prompt.refreshOf));
  }

  // --- Date ------------------------------------------------------------------
  // Without this the model dates things to its training data: the first e2e
  // article, generated in August 2026, titled itself "...in 2025". A wrong
  // year in a title is the fastest way for a reader to write a page off as
  // machine-made and stale, and it is also simply false.
  const now = new Date();
  sections.push(
    `Today's date is ${now.toISOString().slice(0, 10)}. When the title or copy ` +
      `references a year, use ${now.getFullYear()}. Do not date claims beyond ` +
      `what your sources support.`
  );

  // --- Title -----------------------------------------------------------------
  if (title) {
    sections.push(`Use the following title for the article:\n${title}`);
  } else {
    // The length rule is here because the scorer measures it and the writer
    // was never told. Measured 2026-09-03 across every article in the
    // database: all fifteen ran past 60 characters, four of them past 80, so
    // Google was cutting the end off every one of them. The model writes a
    // full sentence when nothing stops it.
    sections.push(
      `Generate a compelling, SEO-optimized title that naturally includes the keyword "${keyword}". ` +
        `Keep it between 50 and 60 characters: Google truncates a title around 60 and the ` +
        `end of the line is where these titles put the year and the promise. Count the ` +
        `characters. Prefer cutting a clause to cutting a word from the keyword.`
    );
  }

  // --- Length -----------------------------------------------------------------
  sections.push(
    prompt.refreshOf
      ? `Length: stay between ${Math.round(refreshLengthBudget(prompt.refreshOf.existingHtml).current * 0.7).toLocaleString()} ` +
          `and ${refreshLengthBudget(prompt.refreshOf.existingHtml).max.toLocaleString()} words. Extend where the brief ` +
          `says the page is thin; never cut it by more than a third; never run past the cap.`
      : band && !prompt.targetWordCount
        ? `Write between ${band.min} and ${band.max} words: the site owner chose this length for this article. ` +
          `Ensure the content is thorough and provides genuine value to the reader. ` +
          `Do not pad to reach the target: stop when the topic is covered.`
        : `Target approximately ${targetWordCount} words. ` +
          (research
            ? `This length is derived from the live SERP: ${research.wordCountBasis}. `
            : "") +
          `Ensure the content is thorough and provides genuine value to the reader. ` +
          `Do not pad to reach the target: stop when the topic is covered.`
  );

  // --- The owner's brief -----------------------------------------------------
  // Before the research, because it outranks it: the SERP says what readers
  // expect, the owner says what this business has actually done. Answers are
  // quoted rather than summarised so the model has the exact words to use,
  // and the boundary is stated twice because the failure mode - a plausible
  // extra anecdote in the owner's voice - is exactly the kind of thing that
  // reads well and is false.
  if (prompt.brief) {
    const b = prompt.brief;
    const lines: string[] = [];
    const label = b.articleSubtype && b.articleSubtype in TAXONOMY_LABELS
      ? TAXONOMY_LABELS[b.articleSubtype as keyof typeof TAXONOMY_LABELS]
      : b.articleType === "listicle"
        ? "List"
        : b.articleType === "guide"
          ? "Guide"
          : null;
    if (label) {
      lines.push(
        `- Article shape: ${label}. ` +
          (b.articleType === "listicle"
            ? "Structure the body as a ranked or grouped list of distinct items, one H2 per item, each with what it is, who it suits and one concrete detail."
            : b.articleSubtype === "howTo"
              ? "Structure the body as numbered steps a reader can follow in order, each with the expected result."
              : b.articleSubtype === "comparison"
                ? "Set the options against each other on the same criteria, in a table, and end with a recommendation that names who should pick which."
                : "Lead with the direct answer, then the detail a reader needs to act on it."),
      );
    }
    if (b.instructions?.trim()) lines.push(`- Instructions for this article: ${b.instructions.trim()}`);
    if (b.answers.length) {
      lines.push(
        "- First-hand experience, in the owner's own words. Use it as the article's",
        "  evidence, attributed to the site (\"we\", \"our team\", or the business name),",
        "  and quote or closely paraphrase it. Use ONLY what is written here as the",
        "  owner's experience: do not invent further examples, results, tools, clients",
        "  or anecdotes in their voice, and do not extend an answer beyond what it says.",
        ...b.answers.flatMap((a) => [`  Q: ${a.question.trim()}`, `  A: ${a.answer.trim()}`]),
      );
    }
    if (lines.length) sections.push(["WHAT THE SITE OWNER TOLD US:", ...lines].join("\n"));
  }

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
      // The alt rule sits with the format rules rather than with SEO because
      // the SEO framing is what produced the problem: told to "include the
      // keyword", a model writes alt="the keyword". It passes a has-alt check
      // and is useless to the screen reader and the crawler alike.
      "- Do not invent <img> URLs. Any image that does appear in the article carries",
      "  an alt attribute that is a full sentence describing what the image shows, at",
      '  least six words ("Bar chart comparing the monthly price of five email tools").',
      `  Never the keyword on its own: alt="${keyword}" tells a screen reader nothing`,
      "  and reads as keyword stuffing to a crawler.",
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
      "- Structure content for featured snippets (clear definitions, numbered steps, tables).",
    ].join("\n")
  );

  // --- What there is to link to ---------------------------------------------
  //
  // Naming the library is the whole difference. The instruction on its own
  // produced no placeholders at all, because "where relevant" is not a question
  // a model can answer without knowing what exists.
  if (prompt.internalLinkTargets?.length) {
    sections.push(
      [
        "INTERNAL LINKS — link to these, and only these:",
        "Each line is an article already published on this site. Where the",
        "draft naturally mentions one of these subjects, link to it once using",
        'the placeholder form <a href="{{internal-link:KEYWORD}}">anchor</a>,',
        "using the keyword exactly as written below. Two to four links is right",
        "for an article of this length. Never invent a target that is not listed.",
        "",
        ...prompt.internalLinkTargets
          .slice(0, 20)
          .map((t) => `- ${t.keyword} — "${t.title}"`),
      ].join("\n"),
    );
  }

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

  // --- Written to be quoted --------------------------------------------------
  //
  // These mirror lib/seo/aeo-scoring.ts one for one. Scoring a draft against
  // rules the writer was never given is a way to produce a low number and no
  // improvement, so the checks and the brief say the same thing.
  sections.push(
    [
      "WRITTEN TO BE QUOTED:",
      "An answer engine lifts a passage, it does not summarise a page. Every",
      "rule below exists so there is a passage worth lifting.",
      "",
      "- Open by answering the question. First paragraph under 90 words, naming",
      "  the subject in the first sentence. No throat-clearing, no context-setting.",
      "- Straight after the opening paragraph, add a block headed <h2>Key takeaways</h2>",
      "  with three to five <li> bullets, each one a complete, quotable sentence.",
      "  No figures in the bullets unless the same figure is sourced in the body.",
      "- Include one standalone definition of 20-70 words that starts with the",
      "  term and makes sense with nothing around it.",
      "- Use at least three specific figures: a number, a percentage, a price, a",
      "  duration. An adjective is not a fact.",
      "- Attribute every figure to a named, linked source. If you cannot source a",
      "  number, do not write the number - say plainly that no reliable figure",
      "  exists, which is itself a quotable answer.",
      "- Cite external sources with real, working links: two at minimum, and about",
      "  one for every 500 words. Every link is fetched after you write; one that",
      '  does not resolve is removed. Never emit href="#" or a placeholder URL.',
      "- Put the link in the sentence that makes the claim: the <a> wraps words inside",
      "  that sentence, next to the figure or the name it supports. Do not collect",
      "  citations in a Sources, References or Further reading list at the end; a link",
      "  three screens below the claim is a link nobody follows, and an answer engine",
      "  quoting the passage does not carry it. If you add such a list anyway, every",
      "  URL in it must already be linked inline where the claim is made.",
      "- A well-known rule of thumb is still an unsourced claim. \"Roughly 80% of",
      "  results come from 20% of pages\", \"most experts agree\", \"studies show\" -",
      "  the fact checker flags these and it is right to. Either attribute the",
      "  figure to something citable or make the point without the number.",
      "- Phrase at least two H2s as the question a person would actually type.",
      "- Keep paragraphs under 120 words.",
      "- Use a real HTML table for any comparison of three or more things.",
    ].join("\n"),
  );

  // --- Site output preferences ---------------------------------------------
  // Set once in onboarding. Rendered only when set, so an install without the
  // settings table behaves exactly as before.
  if (prompt.output) {
    const o = prompt.output;
    const prefs: string[] = [];
    if (o.tone && o.tone !== "informative") prefs.push(`- Overall tone: ${o.tone}.`);
    if (typeof o.internalLinks === "number") {
      prefs.push(
        o.internalLinks === 0
          ? "- Do not add internal-link placeholders."
          : `- Aim for about ${o.internalLinks} internal-link placeholder${o.internalLinks === 1 ? "" : "s"} where they genuinely help.`,
      );
    }
    if (o.tableOfContents === false) prefs.push("- Do not add a table of contents.");
    if (o.callToAction === false) prefs.push("- Do not add a closing call to action.");
    if (o.firstPerson === false) prefs.push("- Write in the third person; never \"we\", \"our\" or \"I\".");
    if (o.firstPerson === true) prefs.push("- First person (\"we\", \"our\") is fine where it reads naturally.");
    if (o.mentionSimilarProducts === false) prefs.push("- Do not name or compare competing products.");
    if (o.mentionSimilarProducts === true) prefs.push("- Where relevant, name and fairly compare similar products or tools.");
    if (o.customInstructions?.trim()) prefs.push(`- Site owner's standing instructions: ${o.customInstructions.trim()}`);
    if (prefs.length) sections.push("", "SITE PREFERENCES:", ...prefs);
  }

  // --- Final instructions ----------------------------------------------------
  sections.push(
    [
      "IMPORTANT:",
      "- Write for humans first, search engines second.",
      "- Every paragraph should deliver value.",
      "- Do NOT include any text outside of the HTML output and the meta-description tag.",
      "",
      // The generic register is the thing readers recognise as machine-written,
      // and it is also what makes a page indistinguishable from the twenty
      // others already ranking. A measured comparison on 2026-08-30 had one
      // model open with "the right platform should automate repetitive tasks"
      // while the other named four actual products; the second is the one worth
      // publishing. These are the specific tells.
      "NEVER WRITE LIKE THIS:",
      '- Banned openers: "In today\'s fast-paced world", "In the ever-evolving landscape",',
      '  "In the digital age", "Whether you are a ... or a ...", "Let\'s dive in", "Look no further".',
      '- Banned connectives and filler: "delve", "tapestry", "realm", "navigate the",',
      '  "unlock the power", "game-changer", "robust solution", "seamlessly", "leverage"',
      '  as a verb, "it is important to note that", "in conclusion".',
      "- No sentence whose only job is to announce what the next sentence will say.",
      "- No paragraph that would still be true if the subject were a different product.",
      '- Do not hedge a real answer into uselessness: "it depends" is only acceptable',
      "  when followed immediately by what it depends on.",
      "- Prefer a named product, number or example over an adjective. If you cannot",
      "  name one, say plainly that there is no standard answer and why.",
      "- Never use an em dash (\u2014). Use a comma, colon, period or parentheses.",
      "  Em dashes are the single most recognised marker of machine writing, and",
      "  a post-processor removes them anyway; write the sentence you mean.",
    ].join("\n")
  );

  return sections.join("\n\n");
}

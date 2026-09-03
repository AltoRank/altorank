// ---------------------------------------------------------------------------
// Citation readiness — will an AI answer quote this page?
// ---------------------------------------------------------------------------
//
// `scoring.ts` answers a different question. Its seven checks are classic
// on-page SEO: is the keyword in the title, is the density sane, is the heading
// tree well formed. All of that is about ranking a page in a list of ten links.
//
// This product's claim is that it gets you named in an AI answer, and nothing
// measured whether an article was built to be quoted. The gap between the
// positioning and the scoring was the whole of it.
//
// The checks below come from the citation-pattern research in the aaron-seo-geo
// pack (references/ai-citation-patterns.md and geo-optimization-techniques.md),
// which groups the factors as definitions, quotable content, authority and
// structure. Each one here is the part of that checklist a machine can decide
// without a judgement call.
//
// Deliberately no model call, for the same reason `recommendations.ts` gives:
// a score that changes between runs on the same text cannot be argued with, and
// "why did this drop" is exactly the question a reviewer asks. Everything here
// is a function of the HTML.

import type { ScoringCheck, ScoringResult } from "./scoring";
import { hrefsIn, isCitationLink } from "./links";

/**
 * Weights, summing to 1.
 *
 * Ordered by what the research says actually moves a citation. Structure and
 * quotable specifics dominate: an answer engine lifts a passage, so a page that
 * contains a liftable passage wins over one that is merely comprehensive.
 * Schema is weighted lowest deliberately - `memory/` records that schema alone
 * did not move anything, and overweighting it would restate a claim we removed
 * from the site.
 */
const WEIGHTS: Record<string, number> = {
  answerFirst: 0.18,
  definitionBlock: 0.12,
  quotableStatistics: 0.14,
  sourcedClaims: 0.14,
  questionHeadings: 0.11,
  scannableStructure: 0.09,
  comparisonTable: 0.07,
  outboundAuthority: 0.08,
  // Added 2026-09-03: the summary box is the second most reproduced block
  // after the direct answer in the citation research, and the prompt already
  // asks for a liftable opening; a takeaways list is the same idea for the
  // whole page.
  summaryBox: 0.07,
};

/**
 * The phrases a summary block announces itself with, across the languages
 * this product writes in. A heading or a bold lead that matches, followed by a
 * list, is the block an answer engine lifts as "the gist".
 */
const SUMMARY_MARKER =
  /\b(?:tl;?\s?dr|key takeaways?|in short|at a glance|quick answer|the short version|in breve|punti chiave|in sintesi|en r[ée]sum[ée]|l'essentiel|en resumen|puntos clave|kurz gesagt|das wichtigste|zusammenfassung)\b/i;

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function blocks(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  return [...html.matchAll(re)].map((m) => m[1]);
}

/**
 * The first substantive paragraph, which is what an answer engine reads to
 * decide whether the page answers the question at all.
 */
function leadParagraph(html: string): string {
  const afterH1 = html.split(/<\/h1>/i)[1] ?? html;
  const first = blocks(afterH1, "p").map(stripHtml).find((t) => t.length > 40);
  return first ?? "";
}

// ── Definitions and answer-first ───────────────────────────────────────────

function checkAnswerFirst(html: string, keyword: string): ScoringCheck {
  const lead = leadParagraph(html);
  const words = lead.split(/\s+/).filter(Boolean).length;
  const opensOnSubject = lead
    .slice(0, 120)
    .toLowerCase()
    .includes(keyword.toLowerCase().split(/\s+/)[0] ?? "");

  // A lead that runs long is a preamble, and a preamble is what gets skipped.
  const passed = opensOnSubject && words > 0 && words <= 90;
  return {
    name: "answerFirst",
    passed,
    score: passed ? 1 : opensOnSubject ? 0.5 : 0,
    note: !lead
      ? "No opening paragraph found."
      : !opensOnSubject
        ? "The opening paragraph does not name the subject in its first sentence."
        : words > 90
          ? `Opening paragraph is ${words} words. Under 90 reads as an answer rather than a preamble.`
          : "Opens by answering the query directly.",
  };
}

function checkDefinitionBlock(html: string, keyword: string): ScoringCheck {
  const paras = blocks(html, "p").map(stripHtml);
  const term = keyword.toLowerCase();
  // The shape an engine lifts: standalone, starts with the term, self-contained.
  const found = paras.find((p) => {
    const w = p.split(/\s+/).length;
    const t = p.toLowerCase();
    return (
      w >= 20 &&
      w <= 70 &&
      t.includes(term) &&
      /\b(is|are|refers to|means)\b/.test(t.slice(0, 160))
    );
  });
  return {
    name: "definitionBlock",
    passed: Boolean(found),
    score: found ? 1 : 0,
    note: found
      ? "Contains a standalone definition an engine can lift whole."
      : `No 20-70 word passage defines "${keyword}" on its own. That passage is what gets quoted.`,
  };
}

// ── Quotable content ───────────────────────────────────────────────────────

/** Figures with a unit or a magnitude: the things an answer actually repeats. */
export function findFigures(text: string): string[] {
  return [
    ...text.matchAll(/\b\d[\d,.]*\s?(?:%|percent|x\b|million|billion|k\b)|\B[$£€]\s?\d[\d,.]*/gi),
  ].map((m) => m[0]);
}

function checkQuotableStatistics(html: string): ScoringCheck {
  const figures = findFigures(stripHtml(html));
  // Not raised above 3, and not made a hard gate: "include figures" and "never
  // invent a figure" pull against each other, and when a subject genuinely has
  // no public numbers the honest article has none. This check rewards
  // specificity; `sourcedClaims` is what stops it becoming a reason to fabricate.
  const passed = figures.length >= 3;
  return {
    name: "quotableStatistics",
    passed,
    score: Math.min(1, figures.length / 3),
    note: passed
      ? `${figures.length} specific figures. Specifics are what get quoted; adjectives are not.`
      : `Only ${figures.length} specific figures. An answer engine repeats numbers, not descriptions.`,
  };
}

function checkSourcedClaims(html: string, siteDomain?: string | null): ScoringCheck {
  const figures = findFigures(stripHtml(html));
  if (figures.length === 0) {
    // Vacuously true, and deliberately not a failure. This check asks whether
    // the figures present are attributed; with none present there is nothing
    // unattributed. Scoring it 0 punished the article that refused to invent a
    // statistic - which is the behaviour the fact checker and this repo's
    // first hard rule both demand. Observed on a real draft that came back
    // clean precisely because it wrote no unsourced numbers.
    return {
      name: "sourcedClaims",
      passed: true,
      score: 1,
      note: "No unsourced figures, because there are no figures. Nothing here overstates the evidence.",
    };
  }
  // A figure is attributed when its own paragraph or list item carries an
  // outbound link. The first version demanded the figure inside the anchor
  // text itself, which failed "200 appointments a month, according to
  // [Setmore's pricing page]" - a correctly cited sentence - and with it every
  // article this product had generated. Table cells are left out of the
  // denominator on both sides: a comparison table restates figures the prose
  // has already cited, and asking for a link per cell would punish exactly
  // the table the comparisonTable check asks for.
  //
  // A source is a link to somewhere other than this site. The resolver writes
  // internal links as absolute URLs on the workspace domain, and those used
  // to pass as sources here, so "see our other guide" counted as a citation.
  const cites = (block: string) => hrefsIn(block).some((h) => isCitationLink(h, siteDomain));
  const proseBlocks = [
    ...blocks(html, "p"),
    ...blocks(html, "li"),
  ];
  const inProse = (f: string) => proseBlocks.some((b) => stripHtml(b).includes(f));
  const proseFigures = figures.filter(inProse);
  if (proseFigures.length === 0) {
    return {
      name: "sourcedClaims",
      passed: true,
      score: 1,
      note: "Every figure sits in a table restating cited prose; nothing bare to source.",
    };
  }
  const sourced = proseFigures.filter((f) =>
    proseBlocks.some((b) => stripHtml(b).includes(f) && cites(b)),
  ).length;
  const ratio = sourced / proseFigures.length;
  return {
    name: "sourcedClaims",
    passed: ratio >= 0.5,
    score: ratio,
    note:
      ratio >= 0.5
        ? `${sourced} of ${proseFigures.length} prose figures sit in a passage with a source link.`
        : `${proseFigures.length - sourced} of ${proseFigures.length} prose figures sit in a passage with no source link. Engines prefer attributable claims, and unattributed ones are what the fact checker flags.`,
  };
}

// ── Structure ──────────────────────────────────────────────────────────────

function checkQuestionHeadings(html: string): ScoringCheck {
  const heads = [...blocks(html, "h2"), ...blocks(html, "h3")].map(stripHtml);
  const questions = heads.filter((h) => h.trim().endsWith("?"));
  const passed = questions.length >= 2;
  return {
    name: "questionHeadings",
    passed,
    score: Math.min(1, questions.length / 2),
    note: passed
      ? `${questions.length} headings are phrased as questions, which is how a query is matched to a passage.`
      : `${questions.length} question-shaped headings. A heading that matches the question asked is the passage an engine returns.`,
  };
}

function checkScannableStructure(html: string): ScoringCheck {
  const paras = blocks(html, "p").map(stripHtml).filter((p) => p.length > 0);
  if (paras.length === 0) {
    return { name: "scannableStructure", passed: false, score: 0, note: "No paragraphs found." };
  }
  const long = paras.filter((p) => p.split(/\s+/).length > 120).length;
  const ratio = 1 - long / paras.length;
  const passed = long === 0;
  return {
    name: "scannableStructure",
    passed,
    score: ratio,
    note: passed
      ? "No wall-of-text paragraphs."
      : `${long} paragraph(s) over 120 words. Long blocks are harder to lift a clean passage from.`,
  };
}

function checkComparisonTable(html: string): ScoringCheck {
  const hasTable = /<table[\s>]/i.test(html);
  const hasList = /<ol[\s>]/i.test(html);
  const score = hasTable ? 1 : hasList ? 0.5 : 0;
  return {
    name: "comparisonTable",
    passed: hasTable,
    score,
    note: hasTable
      ? "Contains a table, which is a structure answer engines reproduce directly."
      : hasList
        ? "Has an ordered list but no table. Comparisons cite better as tables."
        : "No table or ordered list. Structured comparisons are among the most reproduced formats.",
  };
}

function checkOutboundAuthority(html: string, siteDomain?: string | null): ScoringCheck {
  // Outbound means off this site. Every absolute URL counted before, so an
  // article whose only links were to its own siblings scored as well-cited.
  const external = hrefsIn(html).filter((h) => isCitationLink(h, siteDomain));
  // Two is the floor; a long piece wants roughly one citation per 500 words,
  // which is the density the citation benchmarks ask for. A 3,000-word guide
  // with two links at the top is not a sourced guide.
  const words = stripHtml(html).split(/\s+/).filter(Boolean).length;
  const required = Math.max(2, Math.round(words / 500));
  const passed = external.length >= required;
  return {
    name: "outboundAuthority",
    passed,
    score: Math.min(1, external.length / required),
    note: passed
      ? `${external.length} outbound citations for ${words} words.`
      : `${external.length} outbound citations; ${required} wanted for ${words} words (one per 500, two minimum). Citing sources is one of the E-E-A-T signals engines weigh.`,
  };
}

/**
 * A summary block near the top: "Key takeaways", "TL;DR", "In short", as a
 * heading or a bold lead, followed by a list. Looked for before the second
 * H2, because a summary at the end is a conclusion, and conclusions are not
 * what gets lifted.
 */
function checkSummaryBox(html: string): ScoringCheck {
  const parts = html.split(/<h2\b/i);
  const top = parts.slice(0, 2).join("<h2");
  const markers = [
    ...blocks(top, "h2"),
    ...blocks(top, "h3"),
    ...blocks(top, "strong"),
    ...blocks(top, "b"),
  ].map(stripHtml);
  const marked = markers.some((t) => SUMMARY_MARKER.test(t));
  const listed = /<(?:ul|ol)\b/i.test(top);
  const score = marked && listed ? 1 : marked ? 0.5 : 0;
  return {
    name: "summaryBox",
    passed: score === 1,
    score,
    note:
      score === 1
        ? "Has a takeaways block near the top, which engines lift as the gist."
        : marked
          ? "A summary heading near the top, but no list under it. Three to five bullets is the shape that gets lifted."
          : "No key-takeaways or TL;DR block before the body. A short bulleted summary after the opening is the second most reproduced block after the direct answer.",
  };
}

/**
 * Score how ready an article is to be cited by an AI answer.
 *
 * Returns the same shape as `scoreArticle`, so both render through one
 * component and a reviewer sees two scores built the same way.
 *
 * `siteDomain` lets the two link checks tell the site's own pages from
 * citations. Without it every absolute URL is treated as outbound, which is
 * the most that can be claimed about a page whose owner is unknown.
 */
export function scoreCitationReadiness(
  html: string,
  keyword: string,
  opts: { siteDomain?: string | null } = {},
): ScoringResult {
  const checks: ScoringCheck[] = [
    checkAnswerFirst(html, keyword),
    checkDefinitionBlock(html, keyword),
    checkQuotableStatistics(html),
    checkSourcedClaims(html, opts.siteDomain),
    checkQuestionHeadings(html),
    checkScannableStructure(html),
    checkComparisonTable(html),
    checkOutboundAuthority(html, opts.siteDomain),
    checkSummaryBox(html),
  ];

  const score = checks.reduce(
    (total, c) => total + c.score * (WEIGHTS[c.name] ?? 0),
    0,
  );

  return { score: Math.round(score * 100), checks };
}

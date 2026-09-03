// ---------------------------------------------------------------------------
// Local SEO content scoring — no external API required
// ---------------------------------------------------------------------------

import { classifyHref } from "./links";

export type ScoringCheck = {
  name: string;
  passed: boolean;
  score: number;
  note?: string;
};

export type ScoringResult = {
  score: number;
  checks: ScoringCheck[];
};

/**
 * Weights for each check (must sum to 1).
 *
 * Rebalanced 2026-09-03 against the rubrics in the installed SEO skills. The
 * first version put 60% on keyword-in-title, density, heading tags and a flat
 * word count, which is the on-page model of ten years ago: the Aaron pack's
 * 80-item benchmark gives that whole family about 1%, and its own on-page
 * rubric scores density above 3% as zero, where ours still passed it. Title
 * length is new and carries the only click-through lever a body of text has.
 * Density and readability lost weight; nothing about a page's usefulness is
 * measured by how often the keyword repeats.
 */
const WEIGHTS: Record<string, number> = {
  keywordInTitle: 0.15,
  titleLength: 0.10,
  keywordDensity: 0.10,
  headingStructure: 0.15,
  metaDescriptionLength: 0.10,
  wordCount: 0.15,
  readability: 0.10,
  internalLinks: 0.15,
};

/** Fallback word target when nothing better is known. */
const DEFAULT_TARGET_WORDS = 1500;

/** Strip HTML tags to get plain text. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Count occurrences of a term (case-insensitive, whole word). */
function countOccurrences(text: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "gi");
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

/** Extract text content from headings at a given level. */
function extractHeadings(html: string, level: number): string[] {
  const regex = new RegExp(`<h${level}[^>]*>(.*?)<\\/h${level}>`, "gi");
  const found: string[] = [];
  let m = regex.exec(html);
  while (m !== null) {
    found.push(stripHtml(m[1]));
    m = regex.exec(html);
  }
  return found;
}

/**
 * Hosts an article links to for reasons other than citing its own site. Only
 * consulted when no domain is known; see below.
 */
const KNOWN_THIRD_PARTY = /youtube\.com|wikipedia\.org|twitter\.com|facebook\.com|linkedin\.com/i;

/**
 * Count links to other pages on this site.
 *
 * With `siteDomain`, a link is internal when it is relative or points at that
 * domain, which is the only honest definition. Without it, an absolute URL
 * cannot be told inside from outside and the old heuristic stands in: anything
 * not on a well-known third-party host is presumed the site's own. Either way,
 * `href="#"`, an in-page anchor and an unresolved placeholder are not links
 * to other pages and never count; the first version counted all three, so a
 * draft with three dead anchors passed this check.
 */
function countInternalLinks(html: string, siteDomain?: string | null): number {
  const linkRegex = /<a[^>]+href=["']([^"']*)["'][^>]*>/gi;
  let count = 0;
  let m = linkRegex.exec(html);
  while (m) {
    const href = m[1];
    const kind = classifyHref(href, siteDomain);
    if (kind === "internal") {
      count++;
    } else if (!siteDomain && kind === "external" && !KNOWN_THIRD_PARTY.test(href)) {
      count++;
    }
    m = linkRegex.exec(html);
  }
  return count;
}

/** Extract meta description from content if present. */
function extractMetaDescription(content: string): string | null {
  // Check for a meta description tag in the content
  const metaRegex = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i;
  const m = content.match(metaRegex);
  if (m) return m[1];

  // Also check the reversed attribute order
  const metaRegex2 = /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i;
  const m2 = content.match(metaRegex2);
  if (m2) return m2[1];

  return null;
}

// ---- Individual check functions ----

function checkKeywordInTitle(content: string, keyword: string): ScoringCheck {
  const titleRegex = /<h1[^>]*>(.*?)<\/h1>/i;
  const titleMatch = content.match(titleRegex);
  const titleText = titleMatch ? stripHtml(titleMatch[1]) : "";

  const passed = titleText.toLowerCase().includes(keyword.toLowerCase());

  return {
    name: "keywordInTitle",
    passed,
    score: passed ? 100 : 0,
    note: passed
      ? "Keyword found in the H1 title"
      : titleText
        ? "Keyword missing from the H1 title"
        : "No H1 tag found in the content",
  };
}

function checkKeywordDensity(content: string, keyword: string): ScoringCheck {
  const plainText = stripHtml(content);
  const words = plainText.split(/\s+/).filter(Boolean);
  const totalWords = words.length;

  if (totalWords === 0) {
    return {
      name: "keywordDensity",
      passed: false,
      score: 0,
      note: "No text content found",
    };
  }

  const keywordCount = countOccurrences(plainText, keyword);
  const keywordWordCount = keyword.split(/\s+/).length;
  const density = (keywordCount * keywordWordCount) / totalWords * 100;
  // 0.5-2% is the band every current rubric agrees on. The old 1-3% band
  // rewarded repetition that the same rubrics call stuffing, and stuffing is
  // the one on-page pattern the AI-search research scores as a negative.
  const passed = density >= 0.5 && density <= 2;

  let score: number;
  if (passed) {
    score = 100;
  } else if (density > 0 && density < 0.5) {
    score = Math.round((density / 0.5) * 70);
  } else if (density > 2 && density <= 3) {
    score = Math.round(100 - (density - 2) * 50);
  } else {
    score = 0;
  }

  return {
    name: "keywordDensity",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note:
      density > 3
        ? `Keyword density: ${density.toFixed(1)}%. Above 3% reads as stuffing to a reader and to a ranker.`
        : `Keyword density: ${density.toFixed(1)}% (target: 0.5-2%)`,
  };
}

function checkHeadingStructure(content: string): ScoringCheck {
  const h1s = extractHeadings(content, 1);
  const h2s = extractHeadings(content, 2);

  const hasOneH1 = h1s.length === 1;
  const hasH2s = h2s.length >= 2;

  let score = 0;
  const notes: string[] = [];

  if (hasOneH1) {
    score += 50;
  } else if (h1s.length === 0) {
    notes.push("Missing H1 tag");
  } else {
    notes.push(`Multiple H1 tags found (${h1s.length})`);
  }

  if (hasH2s) {
    score += 50;
  } else {
    notes.push(`Only ${h2s.length} H2 tags found (recommend 2+)`);
  }

  return {
    name: "headingStructure",
    passed: hasOneH1 && hasH2s,
    score,
    note: notes.length > 0 ? notes.join("; ") : "Good heading hierarchy",
  };
}

/**
 * Title length, for the one on-page lever that moves clicks.
 *
 * Google shows about 60 characters of a title; past that the end is cut,
 * and the end of a generated title is usually where the year or the promise
 * sits. Read from the H1, which is where the generator puts the title, or
 * from the stored title when the caller has it.
 */
function checkTitleLength(content: string, stored?: string | null): ScoringCheck {
  const h1 = content.match(/<h1[^>]*>(.*?)<\/h1>/i);
  const title = (stored?.trim() || (h1 ? stripHtml(h1[1]) : "")).trim();
  if (!title) {
    return { name: "titleLength", passed: false, score: 0, note: "No title found" };
  }
  const len = title.length;
  const passed = len >= 30 && len <= 60;
  const score = passed
    ? 100
    : len > 60
      ? Math.max(0, 100 - (len - 60) * 3)
      : Math.round((len / 30) * 70);
  return {
    name: "titleLength",
    passed,
    score,
    note: passed
      ? `Title length: ${len} chars, displays whole in results`
      : len > 60
        ? `Title length: ${len} chars. Google truncates around 60, so the end will not show.`
        : `Title length: ${len} chars. Short titles leave the result line half empty; 50-60 is the target.`,
  };
}

function checkMetaDescriptionLength(
  content: string,
  stored?: string | null,
  keyword?: string,
): ScoringCheck {
  // The meta description is extracted into its own column before the HTML is
  // stored, so grepping the content for the tag found nothing - which made
  // this check fail on every article that ever existed, including ones whose
  // meta description was fine. A check that cannot pass is not a check.
  // Callers pass the stored column; the extraction stays as a fallback for
  // raw model output that still carries the tag.
  const meta = stored?.trim() || extractMetaDescription(content);

  if (!meta) {
    return {
      name: "metaDescriptionLength",
      passed: false,
      score: 0,
      note: "No meta description found",
    };
  }

  const len = meta.length;
  const lengthOk = len >= 120 && len <= 160;
  // Google bolds the query where it appears in the snippet, which is a
  // measurable click lift; a description without the keyword forfeits it.
  const hasKeyword = !keyword || meta.toLowerCase().includes(keyword.toLowerCase());
  const passed = lengthOk && hasKeyword;

  let score: number;
  if (lengthOk) {
    score = 100;
  } else if (len > 0 && len < 120) {
    score = Math.round((len / 120) * 80);
  } else if (len > 160 && len <= 200) {
    score = Math.round(100 - ((len - 160) / 40) * 50);
  } else {
    score = 20;
  }
  if (!hasKeyword) score = Math.round(score * 0.7);

  const notes = [`${len} chars (target: 120-160)`];
  if (!hasKeyword) notes.push("keyword missing, so nothing is bolded in the snippet");

  return {
    name: "metaDescriptionLength",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note: `Meta description: ${notes.join("; ")}`,
  };
}

/**
 * Length against what the query actually wants.
 *
 * The research layer derives a target from the pages that rank (see
 * `recommendedWordCount` in lib/seo/research.ts) and the prompt writes to it,
 * so a transactional query that ranks 600-word pages was being told to write
 * 600 words and then scored as if 1,500 were the floor. The target is passed
 * in when known; 1,500 remains the fallback.
 */
function checkWordCount(content: string, target?: number | null): ScoringCheck {
  const plainText = stripHtml(content);
  const words = plainText.split(/\s+/).filter(Boolean).length;
  const goal = target && target > 0 ? Math.round(target) : DEFAULT_TARGET_WORDS;
  const passed = words >= goal * 0.8;

  const score = words >= goal
    ? 100
    : words >= goal * 0.8
      ? 85
      : Math.round((words / goal) * 70);

  return {
    name: "wordCount",
    passed,
    score,
    note: target
      ? `Word count: ${words} (target: ~${goal}, from what ranks for this query)`
      : `Word count: ${words} (target: ${goal}+)`,
  };
}

function checkReadability(content: string): ScoringCheck {
  const plainText = stripHtml(content);
  const sentences = plainText
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) {
    return {
      name: "readability",
      passed: false,
      score: 0,
      note: "No sentences found in content",
    };
  }

  const avgSentenceLength =
    plainText.split(/\s+/).filter(Boolean).length / sentences.length;

  // Ideal average sentence length: 15-20 words
  const passed = avgSentenceLength >= 10 && avgSentenceLength <= 25;

  let score: number;
  if (avgSentenceLength >= 10 && avgSentenceLength <= 25) {
    score = 100;
  } else if (avgSentenceLength < 10) {
    score = Math.round(avgSentenceLength * 10);
  } else {
    // Penalise overly long sentences
    score = Math.round(Math.max(0, 100 - (avgSentenceLength - 25) * 5));
  }

  return {
    name: "readability",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note: `Average sentence length: ${avgSentenceLength.toFixed(1)} words (target: 10-25)`,
  };
}

function checkInternalLinks(content: string, siteDomain?: string | null): ScoringCheck {
  const count = countInternalLinks(content, siteDomain);
  const passed = count >= 3;

  let score: number;
  if (count >= 3) {
    score = 100;
  } else {
    score = Math.round((count / 3) * 100);
  }

  return {
    name: "internalLinks",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note: `Internal links found: ${count} (target: 3+)`,
  };
}

/**
 * Score an article's HTML content for SEO quality against a target keyword.
 *
 * @param content  HTML content of the article
 * @param keyword  Target keyword to check for
 * @param opts     `metaDescription`: the stored column, since the tag is
 *                 extracted before the HTML is saved. `siteDomain`: the
 *                 workspace domain, so a link can be told inside from outside.
 *                 `targetWordCount`: the SERP-derived length from research.
 *                 `title`: the stored title, when the H1 is not it.
 * @returns        Overall score (0-100) and individual check results
 */
export function scoreArticle(
  content: string,
  keyword: string,
  opts?: {
    metaDescription?: string | null;
    siteDomain?: string | null;
    targetWordCount?: number | null;
    title?: string | null;
  },
): ScoringResult {
  const checks: ScoringCheck[] = [
    checkKeywordInTitle(content, keyword),
    checkTitleLength(content, opts?.title),
    checkKeywordDensity(content, keyword),
    checkHeadingStructure(content),
    checkMetaDescriptionLength(content, opts?.metaDescription, keyword),
    checkWordCount(content, opts?.targetWordCount),
    checkReadability(content),
    checkInternalLinks(content, opts?.siteDomain),
  ];

  // Weighted average
  let totalScore = 0;
  for (const check of checks) {
    const weight = WEIGHTS[check.name] ?? 0;
    totalScore += check.score * weight;
  }

  return {
    score: Math.round(totalScore),
    checks,
  };
}

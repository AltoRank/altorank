// ---------------------------------------------------------------------------
// Local SEO content scoring — no external API required
// ---------------------------------------------------------------------------

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

// Weights for each check (must sum to 1)
const WEIGHTS: Record<string, number> = {
  keywordInTitle: 0.15,
  keywordDensity: 0.15,
  headingStructure: 0.15,
  metaDescriptionLength: 0.10,
  wordCount: 0.15,
  readability: 0.15,
  internalLinks: 0.15,
};

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

/** Count internal links — relative paths, hash links, and resolved URLs (not placeholders or known external sites). */
function countInternalLinks(html: string): number {
  const linkRegex = /<a[^>]+href=["']([^"']*)["'][^>]*>/gi;
  let count = 0;
  let m = linkRegex.exec(html);
  while (m) {
    const href = m[1];
    const isPlaceholder = href.includes("{{internal-link:");
    const isRelative = href.startsWith("/") || href.startsWith("#");
    const isAbsolute = href.startsWith("http");
    const isKnownExternal =
      isAbsolute &&
      /youtube\.com|wikipedia\.org|twitter\.com|facebook\.com|linkedin\.com/i.test(href);

    if (!isPlaceholder && (isRelative || (isAbsolute && !isKnownExternal))) {
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
  const passed = density >= 1 && density <= 3;

  let score: number;
  if (density >= 1 && density <= 3) {
    score = 100;
  } else if (density > 0 && density < 1) {
    score = Math.round(density * 100);
  } else if (density > 3 && density <= 5) {
    score = Math.round(100 - (density - 3) * 25);
  } else {
    score = 0;
  }

  return {
    name: "keywordDensity",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note: `Keyword density: ${density.toFixed(1)}% (target: 1-3%)`,
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

function checkMetaDescriptionLength(
  content: string,
  stored?: string | null,
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
  const passed = len >= 120 && len <= 160;

  let score: number;
  if (passed) {
    score = 100;
  } else if (len > 0 && len < 120) {
    score = Math.round((len / 120) * 80);
  } else if (len > 160 && len <= 200) {
    score = Math.round(100 - ((len - 160) / 40) * 50);
  } else {
    score = 20;
  }

  return {
    name: "metaDescriptionLength",
    passed,
    score: Math.max(0, Math.min(100, score)),
    note: `Meta description length: ${len} chars (target: 120-160)`,
  };
}

function checkWordCount(content: string): ScoringCheck {
  const plainText = stripHtml(content);
  const words = plainText.split(/\s+/).filter(Boolean).length;
  const passed = words >= 1500;

  let score: number;
  if (words >= 1500) {
    score = 100;
  } else if (words >= 1000) {
    score = 70;
  } else if (words >= 500) {
    score = 40;
  } else {
    score = Math.round((words / 500) * 20);
  }

  return {
    name: "wordCount",
    passed,
    score,
    note: `Word count: ${words} (target: 1500+)`,
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

function checkInternalLinks(content: string): ScoringCheck {
  const count = countInternalLinks(content);
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
 * @returns        Overall score (0-100) and individual check results
 */
export function scoreArticle(
  content: string,
  keyword: string,
  opts?: { metaDescription?: string | null },
): ScoringResult {
  const checks: ScoringCheck[] = [
    checkKeywordInTitle(content, keyword),
    checkKeywordDensity(content, keyword),
    checkHeadingStructure(content),
    checkMetaDescriptionLength(content, opts?.metaDescription),
    checkWordCount(content),
    checkReadability(content),
    checkInternalLinks(content),
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

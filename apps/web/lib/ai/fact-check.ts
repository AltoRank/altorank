// ---------------------------------------------------------------------------
// Fact-checking generated articles
// ---------------------------------------------------------------------------
//
// Finds claims a reader would expect to be sourced, and reports which ones are
// not. This is the detection half of the rule that `buildSystemPrompt` states
// as prevention: do not invent statistics.
//
// Deliberately deterministic. An LLM "verification" pass that cannot actually
// read the cited source would produce confident verdicts with nothing behind
// them, which is a worse failure than no check at all: a green tick that means
// nothing gets trusted. What this does instead is narrow, honest and cheap:
// point a human at the exact sentences that carry unsourced numbers.
//
// The bar for flagging is "would a sceptical editor ask where this came from",
// not "is this false". We cannot know what is false. We can know what is
// unattributed, and unattributed is the actionable category.
//
// Every pattern here is language: what a percentage looks like ("%20",
// "yüzde 20"), how a thousand is grouped ("1.500,50"), how a source is named
// ("according to Gartner", "Gartner'a göre"). They come from the locale
// contract (lib/i18n/locale). Until 2026-09-22 they were English only, and
// the first Turkish draft's figures went unseen. A language the contract does
// not describe is not checked with English rules: the verdict is `unchecked`,
// which a reviewer sees and auto-approve refuses.

import { stripTags } from "@/lib/audit/html-utils";
import type { ArticleResearch } from "@/lib/seo/research";
import type { SiteFacts } from "@/lib/ai/types";
import {
  resolveLocale,
  notCheckedFor,
  escapeRegex,
  foldCase,
  inflection,
  phrasePattern,
  type Locale,
  type SupportedLocale,
} from "@/lib/i18n/locale";

export type ClaimKind =
  | "statistic"
  | "money"
  | "multiplier"
  | "large_count"
  | "research_reference"
  | "superlative";

export type ClaimStatus =
  | "unsourced"          // a figure with no attribution anywhere in the sentence
  | "needs_verification" // a source is named, but nobody has checked it exists
  | "corroborated"       // the figure also appears in a page ranking for this keyword
  | "verified"           // the cited page was opened and carries this figure
  | "contradicted";      // the cited page was opened and does not

export type ClaimSeverity = "high" | "medium" | "low";

export interface ExtractedClaim {
  id: string;
  kind: ClaimKind;
  status: ClaimStatus;
  severity: ClaimSeverity;
  /** The matched fragment, e.g. "73%". When a sentence carries several, this
   *  is them joined, and `figures` has them individually. */
  text: string;
  /** Every figure found in this sentence. One sentence is one decision. */
  figures: string[];
  /** The full sentence, so a reviewer can judge without opening the article. */
  sentence: string;
  /** The named source, when the sentence attributes the claim. */
  attribution: string | null;
  /** The first outbound link in the same block: the page this claim points at,
   *  and the one `verifyCitedFigures` opens. */
  sourceUrl: string | null;
  /** What the reviewer should do about it. */
  note: string;
}

export interface FactCheckReport {
  claims: ExtractedClaim[];
  counts: Record<ClaimSeverity, number> & { total: number };
  /**
   * `clean` nothing to review, `review` some claims, `high_risk` unsourced
   * figures, `unchecked` the article's language is not one the checker reads
   * (so nothing was checked, which is not the same as nothing found).
   */
  verdict: "clean" | "review" | "high_risk" | "unchecked";
  summary: string;
  /**
   * The language the claims were read in. Absent on reports stored before
   * 2026-09-25, which were all read with the English rules.
   */
  language?: { code: string; name: string; supported: boolean };
}

// ── Patterns ───────────────────────────────────────────────────────────────

interface ClaimPattern {
  kind: ClaimKind;
  pattern: RegExp;
  /** Severity when the sentence carries no attribution. */
  bareSeverity: ClaimSeverity;
}

const E = String.raw`(?![\p{L}\p{N}_])`;
const SYMBOLS = "[$€£¥₺]";
const PATTERNS = new Map<string, ClaimPattern[]>();

/**
 * The claim patterns for one language, built from the locale contract. For
 * English they are the patterns this file always had.
 */
function claimPatterns(locale: SupportedLocale): ClaimPattern[] {
  const cached = PATTERNS.get(locale.code);
  if (cached) return cached;
  const n = locale.numbers;
  const pct = String.raw`\d{1,3}(?:[.,]\d+)?`;
  const amount = String.raw`\d(?:[\d.,]*\d)?`;
  const suffixes = inflection(locale);
  const scale = n.scaleWords.join("|");

  const statistic = [
    String.raw`\b${pct}\s?%`,
    ...(n.percentSignBefore ? [String.raw`%\s?${pct}`] : []),
    ...(n.percentWordsAfter.length ? [String.raw`\b${pct}\s+(?:${phrasePattern(n.percentWordsAfter)})${E}`] : []),
    ...(n.percentWordsBefore.length ? [String.raw`(?<![\p{L}])(?:${phrasePattern(n.percentWordsBefore)})\s+${pct}`] : []),
  ];
  const money = [
    // The digit run must END on a digit. `[\d.,]*` was greedy enough to take
    // the comma after the number, so "$1,000-$9,999, and" yielded the figure
    // "$9,999, " - trailing comma and space included - which then appeared
    // verbatim in the reviewer's refusal message.
    String.raw`${SYMBOLS}\s?${amount}(?:\s?(?:${scale}))?${E}`,
    // A scale word may sit between the amount and a currency written after
    // it: "2,5 milyar TL", "85 milyon dolar" is how Turkish writes large
    // money, and without the scale the sentence carried no claim at all. In a
    // language that inflects, the currency takes its case suffix too
    // ("1,2 trilyon liraya").
    String.raw`\b${amount}(?:\s?(?:${scale}))?\s?(?:${n.currencyAfter.join("|")})${suffixes}(?![\p{L}])`,
    ...(n.symbolAfter ? [String.raw`\b${amount}\s?${SYMBOLS}`] : []),
  ];
  const multiplier = [
    String.raw`\b\d+(?:[.,]\d+)?\s?x${E}`,
    ...n.multiplierWords.map((w) => String.raw`\b\d+(?:[.,]\d+)?\s*(?:${w})${E}`),
  ];
  // Grouped numbers (1,200; 1.200 in Turkish) or scaled counts tied to a
  // countable noun. The noun requirement keeps "over 200 words" from reading
  // as a market claim. Abbreviated scales ("k", "m") only count money.
  const counted = n.scaleWords.filter((w) => w.replace(/\\\.\??/g, "").length > 2);
  const largeCount = [
    String.raw`\b\d{1,3}(?:${escapeRegex(n.group)}\d{3})+(?:${escapeRegex(n.decimal)}\d+)?${E}`,
    ...(counted.length
      ? [String.raw`\b\d+(?:[.,]\d+)?\s?(?:${counted.join("|")})\s+(?:${n.countNouns.join("|")})${suffixes}${E}`]
      : []),
  ];

  const patterns: ClaimPattern[] = [
    { kind: "statistic", pattern: new RegExp(statistic.join("|"), "giu"), bareSeverity: "high" },
    { kind: "money", pattern: new RegExp(money.join("|"), "giu"), bareSeverity: "high" },
    { kind: "multiplier", pattern: new RegExp(multiplier.join("|"), "giu"), bareSeverity: "high" },
    { kind: "large_count", pattern: new RegExp(largeCount.join("|"), "giu"), bareSeverity: "high" },
    // "studies show", "research found" - an appeal to evidence. Harmless when
    // the evidence is named, hollow when it is not. Each language excludes its
    // possessives: "our data shows" points at the author's own numbers, not
    // at an unnamed external study, and flagging those trains people to
    // ignore the checker.
    { kind: "research_reference", pattern: locale.prose.evidenceAppeal, bareSeverity: "high" },
    { kind: "superlative", pattern: locale.prose.superlative, bareSeverity: "medium" },
  ];
  PATTERNS.set(locale.code, patterns);
  return patterns;
}

// ── Text extraction ────────────────────────────────────────────────────────

interface Block {
  text: string;
  /** hrefs of anchors inside this block, used to spot inline citations. */
  hrefs: string[];
}

/**
 * A sentinel that cannot occur in article HTML, used to mark block boundaries
 * before tags are stripped. A plain space would be indistinguishable from the
 * spaces already in the text.
 */
const BLOCK_SEP = "\u0000BLOCK\u0000";
const BLOCK_END = /<\/(?:p|h[1-6]|li|blockquote|td|th|div|figcaption)>|<br\s*\/?>/gi;

/**
 * Split HTML into blocks, keeping each block's links.
 *
 * Blocks matter because sentence detection must not run across a heading into
 * the paragraph below it, which would attach the wrong context to a claim.
 */
function toBlocks(html: string): Block[] {
  // A table is one block, not one per cell.
  //
  // `td`/`th` are block boundaries above, which is right for prose but turns a
  // five-row pricing table into eight separate "unsourced claim" entries - one
  // per number - when the reviewer has exactly one decision to make: cite the
  // table or cut it. Cells are joined with a separator that survives the
  // sentence splitter so the figures stay in one context.
  //
  // The markup is kept, not stripped. `stripTags` here removed the cells'
  // anchors before the pass below could collect them, so `hasCitationLink`
  // was false for every table in the product - including the comparison
  // tables `lib/content/enrich` adds and `scoreCitationReadiness` rewards.
  // Every figure in one was therefore reported `unsourced`/high, the verdict
  // went `high_risk`, and `approvalBlocker` refused the article telling the
  // reviewer to "attribute each one to a linked source" when the cell already
  // linked to its source. There was no edit that satisfied it short of
  // deleting the table. The generic pass below strips the tags anyway.
  const tablesFlattened = html.replace(
    /<table[\s\S]*?<\/table>/gi,
    (table) => `<p>${table.replace(BLOCK_END, " · ")}</p>`,
  );

  return tablesFlattened
    .replace(BLOCK_END, BLOCK_SEP)
    .split(BLOCK_SEP)
    .map((chunk) => ({
      text: stripTags(chunk).trim(),
      hrefs: [...chunk.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => m[1]),
    }))
    .filter((b) => b.text.length > 0);
}

// Placeholders that survive the sentence split and are restored afterwards.
// Control characters, written as escapes: raw ones made git treat this file
// as binary, so no change to it could be reviewed as a diff.
const ABBREV_DOT = "\u0001";
const DECIMAL_DOT = "\u0002";

/**
 * Sentence split that does not break on common abbreviations or on decimals.
 *
 * Perfect segmentation is not needed: the sentence is context for a human, and
 * an over-long sentence is a much smaller problem than a truncated one that
 * hides the source the author actually gave.
 */
function toSentences(text: string, locale: SupportedLocale): string[] {
  const abbreviations = new RegExp(`(?<![\\p{L}])(?:${locale.prose.abbreviations.join("|")})\\.`, "giu");
  const guarded = text
    // Dotted acronyms - "U.S.", "U.K.", "E.U.", "Ph.D.", "a.m.", "A.Ş." -
    // where the shape is the rule and no word list can keep up. Left
    // unguarded, "the U.S. Bureau of Labor Statistics ... is projected to
    // grow 5 percent" split after "U.S.", and the half carrying the figure
    // began "Bureau of Labor Statistics, employment of ...", which no
    // attribution marker matches. The article named its source; the checker
    // reported the claim as unattributed anyway, which is the false alarm
    // this whole file is supposed to avoid.
    .replace(/(?<![\p{L}])(?:\p{L}{1,2}\.){2,}/gu, (m) => m.replace(/\./g, ABBREV_DOT))
    // The language's own abbreviations: "e.g.", "vb.", "ecc.", "bzw.".
    .replace(abbreviations, (m) => m.replace(/\./g, ABBREV_DOT))
    .replace(/(\d)\.(\d)/g, `$1${DECIMAL_DOT}$2`);

  // A sentence starts with a capital in any script ("Şirketlerin…",
  // "İlk…"), a digit, a quote, or a figure's own sign ("%40'ı…").
  return guarded
    .split(/(?<=[.!?])\s+(?=[\p{Lu}0-9"'“(%$€£₺])/u)
    .map((s) =>
      s
        .split(ABBREV_DOT).join(".")
        .split(DECIMAL_DOT).join(".")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Drop a bare number when the same number is already present with its currency.
 *
 * The money and large_count patterns both fire on "$1,000", giving "$1,000"
 * and "1,000" as two figures for one price. Only that exact overlap is
 * removed: the test is that the longer figure ends with the shorter one AND
 * the character in front of it is a currency symbol, so "20%" survives
 * alongside "120%" - which a plain substring check would have eaten. Where
 * the currency comes after the amount ("1.500,50 TL", "1.500 €") the longer
 * figure starts with the shorter one and a space or a symbol follows it.
 */
export function dropCurrencyDuplicates(figures: string[]): string[] {
  return figures.filter(
    (b) =>
      !figures.some((a) => {
        if (a === b) return false;
        if (a.endsWith(b)) {
          const before = a[a.length - b.length - 1];
          return before !== undefined && /[$€£¥₺\s]/.test(before);
        }
        if (a.startsWith(b)) {
          const after = a[b.length];
          return after !== undefined && /[$€£¥₺\s]/.test(after);
        }
        return false;
      }),
  );
}

/**
 * The source a sentence attributes its claim to, or null. The markers are
 * the language's own ("according to X", "secondo X", "X'e göre"), from the
 * locale contract; a language it does not describe has none, and nothing is
 * read as attributed.
 */
export function findAttribution(sentence: string, language?: string | null): string | null {
  const locale = resolveLocale(language);
  if (!locale.supported) return null;
  for (const marker of locale.prose.attribution) {
    const m = sentence.match(marker);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Stable per-report id: same article in, same ids out. */
function claimId(index: number, kind: string, text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${index}-${kind}-${slug}`.slice(0, 64);
}

// ── Corroboration ──────────────────────────────────────────────────────────

/**
 * Weak corroboration: does this exact figure also appear in a page that ranks
 * for the keyword?
 *
 * Not verification, and labelled as such everywhere it surfaces. A number
 * appearing in a competitor's snippet means somebody else published it too,
 * which is worth a reviewer knowing and is not evidence that it is true.
 */
function corroborate(text: string, research?: ArticleResearch): string | null {
  if (!research) return null;
  const needle = foldCase(text.trim());
  if (needle.length < 2) return null;

  for (const c of research.competitors) {
    const haystack = foldCase(`${c.title} ${c.description}`);
    if (haystack.includes(needle)) return c.domain;
  }
  return null;
}

/**
 * The statements from the business's own pages that can carry a figure, for
 * `ArticleResearch.siteStatements`: its founding, team and location
 * statements, the opening of its about page, and its section headings.
 * Nothing else in the site facts carries figures.
 */
export function siteStatementsOf(site: SiteFacts): Array<{ text: string; source: string }> {
  return [
    ...site.stated.map((x) => ({ text: x.text, source: x.source })),
    ...(site.about ? [{ text: site.about.text, source: site.about.source }] : []),
    ...site.headings.map((h) => ({ text: h.items.join("\n"), source: h.url })),
  ];
}

/**
 * The business's own page that states this figure, or null.
 *
 * The writer is told to use the figures the business's pages state (the
 * site-facts section of the prompt: founding year, team size, the count of
 * projects its portfolio claims) and is never told to link them - and an
 * internal link would not count, only an external one is a citation here.
 * So every such figure came back `unsourced`, `high` for most kinds, and a
 * draft that did exactly what the brief asked could not be approved (round-3
 * and round-4 reviews). A figure the business states about itself is
 * sourced: to the business. It is still not verified - a page can be out of
 * date - so it goes to the reviewer as a medium item naming the page, and
 * never blocks approval.
 *
 * Matched on the figure as written, bounded so "20" matches neither "2020"
 * nor "1.200", in the statements saved with the research, so approval reads
 * the same evidence generation did.
 */
function statedBySite(figure: string, research?: ArticleResearch): string | null {
  const statements = research?.siteStatements;
  if (!statements?.length) return null;
  const needle = foldCase(figure.trim());
  if (!/\p{N}/u.test(needle)) return null;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bounded = new RegExp(`(?<![\\p{N}.,])${escaped}(?![\\p{N}]|[.,]\\p{N})`, "u");
  for (const st of statements) {
    if (bounded.test(foldCase(st.text))) return st.source;
  }
  return null;
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Extract and grade the checkable claims in a generated article.
 *
 * `research` is optional and only used for corroboration; the check itself does
 * not depend on it. `language` is the workspace's (`workspaces.language`): the
 * patterns are that language's, and a language the locale contract does not
 * describe gets an `unchecked` report rather than an English reading.
 */
export function factCheckArticle(
  html: string,
  research?: ArticleResearch,
  language?: string | null,
): FactCheckReport {
  const locale = resolveLocale(language);
  if (!locale.supported) return uncheckedReport(locale);
  const patterns = claimPatterns(locale);
  const claims: ExtractedClaim[] = [];
  const seen = new Set<string>();
  let index = 0;

  for (const block of toBlocks(html)) {
    const citationUrl = block.hrefs.find(isExternal) ?? null;
    const hasCitationLink = citationUrl !== null;

    for (const sentence of toSentences(block.text, locale)) {
      const attribution = findAttribution(sentence, locale.code);

      // Collect across every pattern first, then emit once. Currency and plain
      // numbers are different kinds, so "$19.95 ... 50,000 emails" used to
      // produce two entries for one sentence and one decision.
      const perSentence: { kind: ClaimKind; figures: string[]; bareSeverity: ClaimSeverity }[] = [];

      for (const { kind, pattern, bareSeverity } of patterns) {
        // Fresh regex per sentence: the patterns are /g and carry lastIndex
        // between uses, which would silently skip matches on later sentences.
        const re = new RegExp(pattern.source, pattern.flags);

        // One entry per sentence, not per number.
        //
        // "SendGrid pricing starts at $19.95 per month for 50,000 emails,
        // against $15 elsewhere" used to produce three separate claims with the
        // same sentence attached to each, and a pricing table produced one per
        // cell. A reviewer makes a single decision about that sentence - source
        // it or cut it - so listing it three times is three times the work and
        // reads as three times the problem.
        const figures = [...new Set(
          [...sentence.matchAll(re)].map((m) => m[0].trim()).filter(Boolean),
        )];
        if (figures.length === 0) continue;
        perSentence.push({ kind, figures, bareSeverity });
      }

      // One entry per sentence. Kind and severity come from the most serious
      // pattern that fired, and the figures are everything found.
      if (perSentence.length > 0) {
        const kind = perSentence[0].kind;
        const bareSeverity = perSentence.some((x) => x.bareSeverity === "high")
          ? ("high" as ClaimSeverity)
          : perSentence[0].bareSeverity;
        const figures = dropCurrencyDuplicates([
          ...new Set(perSentence.flatMap((x) => x.figures)),
        ]);
        {
          const text = figures.join(", ");
          const dedupeKey = `${kind}:${text}:${sentence}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          // Corroborated only when every figure in the sentence is.
          const corroboratedBy = figures
            .map((f) => corroborate(f, research))
            .reduce<string | null>((acc, cur, i) => (i === 0 ? cur : acc && cur ? acc : null), null);

          // Stated by the business only when every figure in the sentence is,
          // on one of its pages.
          const statedOn = figures
            .map((f) => statedBySite(f, research))
            .reduce<string | null>((acc, cur, i) => (i === 0 ? cur : acc && cur ? acc : null), null);

          let status: ClaimStatus;
          let severity: ClaimSeverity;
          let note: string;

          if (attribution) {
            status = "needs_verification";
            severity = "medium";
            note =
              `Attributed to ${attribution}. Confirm the source exists and ` +
              `actually says this before publishing.`;
          } else if (hasCitationLink) {
            status = "needs_verification";
            severity = "medium";
            note =
              "The paragraph links out, but the claim is not attributed in the " +
              "sentence. Check the link supports this figure, and name the source in the text.";
          } else if (statedOn) {
            status = "needs_verification";
            severity = "medium";
            note =
              `The business states this on its own page (${statedOn}). ` +
              `Confirm it is still current before publishing.`;
          } else if (corroboratedBy) {
            status = "corroborated";
            severity = "medium";
            note =
              `The same figure appears on ${corroboratedBy}, which ranks for this ` +
              `keyword. That means it has been published elsewhere, not that it is ` +
              `correct. Find the primary source or cut the figure.`;
          } else {
            status = "unsourced";
            severity = bareSeverity;
            note =
              kind === "research_reference"
                ? "Appeals to research without naming it. Name the study or remove the appeal."
                : "No source given anywhere in the sentence. Attribute it or remove it.";
          }

          claims.push({
            id: claimId(index++, kind, text),
            kind,
            figures,
            status,
            severity,
            text,
            sentence: sentence.length > 400 ? `${sentence.slice(0, 397)}...` : sentence,
            attribution,
            sourceUrl: citationUrl ?? (attribution ? null : statedOn),
            note,
          });
        }
      }
    }
  }

  return summarise(claims, locale);
}

/**
 * The report for an article in a language the checker cannot read. No
 * claims, because none were looked for; the verdict says so, and the summary
 * is the sentence the reviewer sees in place of a list.
 */
export function uncheckedReport(locale: Locale): FactCheckReport {
  return {
    claims: [],
    counts: { high: 0, medium: 0, low: 0, total: 0 },
    verdict: "unchecked",
    summary: `${notCheckedFor(locale)} Check every figure in this draft against its source by hand.`,
    language: { code: locale.code, name: locale.name, supported: false },
  };
}

/**
 * Counts, verdict and one-line summary for a set of claims.
 *
 * Shared with `verifyCitedFigures`, which re-judges claims after opening the
 * pages they cite and must recount what it changed. The verdict rule is the
 * one thing that must not be duplicated: `high_risk` is what blocks a publish.
 */
export function summarise(
  claims: ExtractedClaim[],
  locale: Locale = resolveLocale("en"),
): FactCheckReport {
  const counts = {
    high: claims.filter((c) => c.severity === "high").length,
    medium: claims.filter((c) => c.severity === "medium").length,
    low: claims.filter((c) => c.severity === "low").length,
    total: claims.length,
  };

  const verdict: FactCheckReport["verdict"] =
    counts.high > 0 ? "high_risk" : counts.total > 0 ? "review" : "clean";

  const wrong = claims.filter((c) => c.status === "contradicted").length;
  const bare = claims.filter((c) => c.status === "unsourced" && c.severity === "high").length;
  const highRiskSummary = [
    wrong ? `${wrong} figure${wrong === 1 ? "" : "s"} the cited page does not contain` : "",
    bare ? `${bare} unsourced claim${bare === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");

  const summary =
    verdict === "clean"
      ? "No unsourced figures or evidence claims found."
      : verdict === "high_risk"
        ? `${highRiskSummary || `${counts.high} claim${counts.high === 1 ? "" : "s"}`} to correct or remove` +
          (counts.medium ? `, plus ${counts.medium} to verify.` : ".")
        : `${counts.total} claim${counts.total === 1 ? "" : "s"} to verify before publishing.`;

  return {
    claims,
    counts,
    verdict,
    summary,
    language: { code: locale.code, name: locale.name, supported: locale.supported },
  };
}

// ── Approval gate ──────────────────────────────────────────────────────────

/**
 * Why this draft may not be approved yet, or null when it may.
 *
 * Every rubric this product was compared against treats an unsourced
 * statistic as zero tolerance, and the marketing copy says drafts are fact
 * checked before they ship. Until now the verdict was shown and the approve
 * button worked regardless. The gate is narrow on purpose: only `high_risk`,
 * which means bare figures with no attribution in the sentence, no link in
 * the paragraph and no corroboration. Named-but-unverified sources remain a
 * reviewer's call.
 *
 * Callers must run the check on the CURRENT content, not the report stored at
 * generation: a reviewer who has just fixed the figures must not be refused
 * on stale evidence.
 */
export function approvalBlocker(report: FactCheckReport): string | null {
  // `unchecked` does not block a person: the reviewer reading the draft is
  // the only check an unsupported language has. Auto-approve has no such
  // reader, which is what `autoApprovalBlocker` is for.
  if (report.verdict !== "high_risk") return null;

  // A figure the cited page does not carry is the more serious of the two and
  // is named first: an unsourced number might still be true, while this one
  // has been checked against the source the article itself chose.
  const wrong = report.claims.filter((c) => c.status === "contradicted");
  if (wrong.length) {
    const sample = wrong.slice(0, 3).map((c) => `"${c.text}"`).join(", ");
    const n = wrong.length;
    return (
      `${n} ${n === 1 ? "figure is" : "figures are"} not on the page the draft cites for ` +
      `${n === 1 ? "it" : "them"} (${sample}${n > 3 ? ", …" : ""}). ` +
      "Correct each one to what the source says or remove it, then approve."
    );
  }

  const bare = report.claims.filter((c) => c.status === "unsourced" && c.severity === "high");
  const sample = bare.slice(0, 3).map((c) => `"${c.text}"`).join(", ");
  const n = bare.length;
  return (
    `${n} unsourced ${n === 1 ? "figure is" : "figures are"} still in the draft` +
    (sample ? ` (${sample}${n > 3 ? ", …" : ""})` : "") +
    ". Attribute each one to a linked source or remove it, then approve."
  );
}

/**
 * Why auto-approve may not ship this draft, or null. Everything that blocks
 * a person, plus a draft nothing could fact-check: approving it unread would
 * publish figures no one and nothing looked at.
 */
export function autoApprovalBlocker(report: FactCheckReport): string | null {
  const blocker = approvalBlocker(report);
  if (blocker) return blocker;
  if (report.verdict === "unchecked") {
    const name = report.language?.name ?? "this language";
    return `not fact-checked: the checker does not read ${name}, so a person has to approve it`;
  }
  return null;
}

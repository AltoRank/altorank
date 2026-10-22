// ---------------------------------------------------------------------------
// Citation verification: does the cited page actually say this?
// ---------------------------------------------------------------------------
//
// `factCheckArticle` answers "is this figure attributed", which is a question
// about the sentence. It cannot answer "is the attribution true", and says so:
// it labels an attributed figure `needs_verification` and asks a human to open
// the link.
//
// Nobody opens the link. A draft for qasimcode.com cited the U.S. Bureau of
// Labor Statistics by name, linked to the correct BLS page, and reported "8
// percent from 2023 to 2033". That page says 5 percent from 2025 to 2035. The
// figure was attributed, so it scored `needs_verification` at medium severity,
// which does not block auto-approve - a wrong number with a real citation
// behind it was one hold window away from publishing itself.
//
// The original file declined to verify on the grounds that an LLM pass "cannot
// actually read the cited source". This one can: it fetches the page and looks
// for the figure. No model, no API cost, one GET per cited URL.
//
// The asymmetry is deliberate. Finding the figure is proof of nothing beyond
// "the page contains this number", and is treated as such. NOT finding it is
// only reported when the page came back whole and readable, because a WAF, a
// paywall or a number rendered by JavaScript all look like absence, and
// calling a true figure false is far worse than leaving it to a human.

import { stripTags } from "@/lib/audit/html-utils";
import { isUnsafeHost } from "@/lib/seo/link-check";
import { until } from "@/lib/onboarding/deadline";
import { bareHost, isBlockedSource, type SourceReview } from "@/lib/seo/source-classes";
import { aboutTopic } from "@/lib/seo/source-figures";
import type { ExtractedClaim, FactCheckReport } from "@/lib/ai/fact-check";
import { ENTITY_KINDS, summarise } from "@/lib/ai/fact-check";
import {
  resolveLocale,
  supportedLocales,
  parseNumber,
  escapeRegex,
  phrasePattern,
  type SupportedLocale,
} from "@/lib/i18n/locale";

export type PageFetcher = (url: string) => Promise<{ status: number; body: string }>;

export interface VerifyCitationsOptions {
  /**
   * What research decided about the sites it read (`research.sourceReview`).
   * A claim citing a business that sells the same service is high risk
   * whatever its page says, and its page is not opened.
   */
  sourceReview?: SourceReview | null;
  /**
   * What the article is about (`research.keyword`). A figure found on its
   * page is `verified` only when the page's own sentence carrying it is
   * about this (`aboutTopic`, `figureOnTopic`); otherwise it stays
   * `needs_verification`, for a person to read.
   */
  topic?: string | null;
  fetcher?: PageFetcher;
  timeoutMs?: number;
  concurrency?: number;
  /**
   * When the pages must have been read (a draft gives the check what is left
   * before its save). Past it no page is opened and the ones in flight are
   * not waited for: their claims are left exactly as the first pass marked
   * them, for a person to open, as an unreadable page's are.
   */
  signal?: AbortSignal | null;
}

const UA =
  "Mozilla/5.0 (compatible; AltoRank-CitationCheck/1.0; +https://altorank.co; citation check)";

/**
 * Below this, the response is a challenge page, a cookie wall or a shell that
 * fills itself in with script - not something whose silence means anything.
 */
const MIN_READABLE_CHARS = 400;

export const defaultPageFetcher = (timeoutMs: number): PageFetcher => async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    });
    const type = res.headers.get("content-type") ?? "";
    // A PDF or a spreadsheet is a real source that this cannot read. Treat it
    // as unreadable rather than as a page missing its figure.
    if (!/^text\/|application\/(?:xhtml|json)/i.test(type)) return { status: res.status, body: "" };
    return { status: res.status, body: (await res.text()).slice(0, 400_000) };
  } finally {
    clearTimeout(timer);
  }
};

/** Page text as one lower-case line, entities resolved, for substring search. */
/**
 * The page's sentences, read the way `readablePageText` reads the page. A
 * block (paragraph, heading, list item, cell) always ends a sentence, so a
 * heading that names the topic is never read as part of the line under it.
 */
export function readableSentences(html: string): string[] {
  return html
    .split(/<\/(?:p|h[1-6]|li|td|th|dt|dd|div|section|article|blockquote|figcaption|caption)>|<br\s*\/?>/i)
    .map(readablePageText)
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Whether every figure in a claim is stated, somewhere on the cited page, in
 * a sentence about `topic`. The page's sentence is the one judged, not the
 * article's: the article's says what the writer made of the figure, and the
 * writer can frame anything as on topic. A diaper-cream draft (2026-10-22)
 * linked "Consumer Reports' guide to choosing a diaper cream" around the
 * magazine's "100% of the fees we collect are used to support our nonprofit
 * mission"; the anchor text named the topic, and the sentence the figure
 * came from does not. A figure the sentences cannot place (split across
 * blocks, say) falls back to the article's sentence.
 */
export function figureOnTopic(
  pageSentences: string[],
  claim: { figures: string[]; sentence: string },
  topic: string | null | undefined,
  language?: string | null,
): boolean {
  if (!topic) return true;
  return claim.figures.every((f) => {
    const carrying = pageSentences.filter((t) => pageHasFigure(t, f, language));
    return carrying.length ? carrying.some((t) => aboutTopic(t, topic)) : aboutTopic(claim.sentence, topic);
  });
}

export function readablePageText(html: string): string {
  return stripTags(html)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&#36;/g, "$")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Currency spellings that name the same money. */
const CURRENCY_ALIASES: Record<string, string[]> = {
  "$": ["$", "usd", "dollars", "dolar", "dollari", "dólares"],
  "€": ["€", "eur", "euro", "euros"],
  "£": ["£", "gbp"],
  "¥": ["¥", "jpy", "yen"],
  "₺": ["₺", "tl", "try", "lira"],
};
const CURRENCY_OF: Record<string, string> = Object.fromEntries(
  Object.entries(CURRENCY_ALIASES).flatMap(([sym, names]) => names.map((n) => [n, sym])),
);

/**
 * A value written every way a page might write it: grouped with commas,
 * dots or spaces, or not at all, with the decimal part (if any) after a dot
 * or a comma. The page may be in any language - a Turkish article citing an
 * English source is the ordinary case - so all of them.
 */
function renderings(value: number, decimals: number): string[] {
  const fixed = value.toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = (sep: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const out = new Set<string>();
  for (const [group, dec] of [[",", "."], [".", ","], [" ", ","], ["", "."], ["", ","]] as const) {
    const whole = group ? grouped(group) : int;
    out.add(frac ? `${whole}${dec}${frac}` : whole);
  }
  return [...out];
}

/** The digits of a figure as a number, read with the article's separators. */
function valueOf(digits: string, locale: SupportedLocale): { value: number; decimals: number } | null {
  const value = parseNumber(digits, locale);
  if (value === null) return null;
  const frac = digits.split(locale.numbers.decimal)[1];
  return { value, decimals: frac && /^\d+$/.test(frac) ? frac.length : 0 };
}

/**
 * Every way a page might write the same figure.
 *
 * "8%" and "8 percent" are the same claim; so are "$30,000", "30,000" and
 * "30000", and so are "%8", "yüzde 8" and "8 Prozent". A page that writes
 * the number differently from the article has not contradicted it, and
 * matching only the article's spelling would report that as a
 * contradiction. The figure is read with the article's language (`1.500,50`
 * is 1500.5 in Turkish) and written back in every supported language's
 * spelling, because the cited page need not share the article's language.
 */
export function figureVariants(figure: string, language?: string | null): string[] {
  const raw = figure.trim().toLowerCase();
  const out = new Set<string>([raw]);
  const locale = resolveLocale(language);
  if (!locale.supported) return [...out];

  const all = supportedLocales();
  const percentAfter = [...new Set(all.flatMap((l) => l.numbers.percentWordsAfter))];
  const percentBefore = [...new Set(all.flatMap((l) => l.numbers.percentWordsBefore))];
  const own = locale.numbers;
  const num = String.raw`(\d[\d.,]*)`;

  const pct =
    raw.match(new RegExp(String.raw`^${num}\s*(?:%|${phrasePattern([...percentAfter])})$`, "u")) ??
    raw.match(new RegExp(String.raw`^%\s*${num}$`, "u")) ??
    (own.percentWordsBefore.length
      ? raw.match(new RegExp(String.raw`^(?:${phrasePattern(own.percentWordsBefore)})\s+${num}$`, "u"))
      : null);
  if (pct) {
    const parsed = valueOf(pct[1], locale);
    const spellings = new Set([pct[1], ...(parsed ? renderings(parsed.value, parsed.decimals) : [])]);
    for (const n of spellings) {
      if (/\s/.test(n)) continue;
      out.add(`${n}%`);
      out.add(`${n} %`);
      out.add(`%${n}`);
      out.add(`% ${n}`);
      for (const w of percentAfter) out.add(`${n} ${w}`);
      for (const w of percentBefore) out.add(`${w} ${n}`);
    }
    return [...out].filter(Boolean);
  }

  const currencies = Object.keys(CURRENCY_OF).map(escapeRegex).join("|");
  const money =
    raw.match(new RegExp(String.raw`^(${currencies})\s?${num}$`, "u")) ??
    raw.match(new RegExp(String.raw`^${num}\s?(${currencies})$`, "u"));
  if (money) {
    const [symbolRaw, digits] = /^\d/.test(money[1]) ? [money[2], money[1]] : [money[1], money[2]];
    const names = CURRENCY_ALIASES[CURRENCY_OF[symbolRaw] ?? symbolRaw] ?? [symbolRaw];
    const parsed = valueOf(digits, locale);
    // Read with the article's separators when they can be; otherwise the old
    // rule, commas out, which is right for the English grouping it assumed.
    const spellings = new Set([digits, ...(parsed ? renderings(parsed.value, parsed.decimals) : [digits.replace(/,/g, "")])]);
    for (const d of spellings) {
      out.add(d);
      for (const name of names) {
        out.add(`${name}${d}`);
        out.add(`${name} ${d}`);
        out.add(`${d}${name}`);
        out.add(`${d} ${name}`);
      }
    }
    return [...out].filter(Boolean);
  }

  if (/^[\d.,]+$/.test(raw)) {
    const parsed = valueOf(raw, locale);
    if (parsed) {
      for (const r of renderings(parsed.value, parsed.decimals)) out.add(r);
    } else {
      out.add(raw.replace(/,/g, ""));
      // 30000 -> 30,000, so a bare number in the article still matches a page
      // that groups its thousands.
      const digits = raw.replace(/[.,]/g, "");
      if (digits.length > 3) out.add(digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    }
  }

  return [...out].filter(Boolean);
}

/**
 * Does the page name this body? Its full name, its name without a bracketed
 * acronym, or the acronym alone ("College of Physiotherapists of Ontario
 * (CPO)" is named by either). `pageText` is `readablePageText`'s: one
 * lower-case line.
 */
export function pageNamesEntity(pageText: string, entity: string): boolean {
  const clean = entity.replace(/\s+/g, " ").trim().replace(/[\s.,;:!?]+$/u, "");
  const acronym = clean.match(/\(([^)]+)\)\s*$/)?.[1] ?? null;
  const bare = clean.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return [clean, bare, acronym]
    .filter((v): v is string => Boolean(v && v.length >= 2))
    .some((v) => pageText.includes(v.toLowerCase()));
}

/**
 * The most cited pages one draft opens. Each is one GET with an 8-second
 * ceiling; a draft that cites more than this leaves the rest for a person.
 */
const MAX_CITED_PAGES = 12;

/** Does the page carry this figure, written any of the usual ways? */
export function pageHasFigure(pageText: string, figure: string, language?: string | null): boolean {
  return figureVariants(figure, language).some((v) => pageText.includes(v));
}

/**
 * Open every cited page once and re-judge the claims that point at it.
 *
 * Only `needs_verification` claims with a source URL are touched: an unsourced
 * figure has nothing to check against, and a corroborated one was never
 * claiming a source in the first place.
 */
export async function verifyCitedFigures(
  report: FactCheckReport,
  opts: VerifyCitationsOptions = {},
): Promise<FactCheckReport> {
  // A report in a language the checker does not read has no claims to open
  // pages for, and its verdict must survive this pass.
  if (report.verdict === "unchecked") return report;
  const language = report.language?.code;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetcher = opts.fetcher ?? defaultPageFetcher(timeoutMs);
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  // A figure on a rival's page is still the rival's figure: finding it there
  // must not turn the claim `verified`. `factCheckArticle` already marks the
  // claims it can see are a rival's (`rival_source`), and those are never
  // re-judged here, because only `needs_verification` is touched. This
  // catches the rest - a report built without the research - before any
  // page is opened.
  const rivalSourced = report.claims.filter(
    (c) => c.status === "needs_verification" && c.sourceUrl && isBlockedSource(c.sourceUrl, opts.sourceReview),
  );
  if (rivalSourced.length) {
    report = summarise(
      report.claims.map((c) =>
        rivalSourced.includes(c)
          ? {
              ...c,
              status: "rival_source" as const,
              severity: "high" as const,
              note:
                `Sourced from ${bareHost(c.sourceUrl!)}, a business that sells what this business sells. Do not send the reader ` +
                `to a competitor or quote it as an authority: replace the source with a public body, research or an association, or cut the claim.`,
            }
          : c,
      ),
      resolveLocale(language),
    );
  }

  const checkable = report.claims.filter(
    (c) => c.status === "needs_verification" && c.sourceUrl && !isUnsafeHost(c.sourceUrl),
  );
  if (checkable.length === 0) return report;

  const urls = [...new Set(checkable.map((c) => c.sourceUrl!))].slice(0, MAX_CITED_PAGES);
  const pages = new Map<string, string | null>();
  const sentences = new Map<string, string[]>();

  const signal = opts.signal ?? null;
  const read = async (url: string): Promise<void> => {
    if (signal?.aborted) {
      pages.set(url, null);
      return;
    }
    try {
      const { status, body } = signal ? await until(fetcher(url), signal, "fact check") : await fetcher(url);
      const text = status >= 200 && status < 300 ? readablePageText(body) : "";
      pages.set(url, text.length >= MIN_READABLE_CHARS ? text : null);
      if (text.length >= MIN_READABLE_CHARS && opts.topic) sentences.set(url, readableSentences(body));
    } catch {
      pages.set(url, null);
    }
  };

  const queue = [...urls];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await read(queue.shift()!);
    }),
  );

  const claims: ExtractedClaim[] = report.claims.map((c) => {
    if (!checkable.includes(c)) return c;
    const text = pages.get(c.sourceUrl!);
    // Unreadable: leave the claim exactly as it was, for a person to open.
    if (!text) return c;

    // A claim about a named body: does the page it cites name that body?
    // Named is not proof it is the regulator, so found is `verified` at low
    // and not found is `unsupported` at medium - for review, never a block,
    // because the page may name it in a form this search cannot see.
    if (ENTITY_KINDS.has(c.kind)) {
      const entity = c.figures[0];
      if (!entity) return c;
      return pageNamesEntity(text, entity)
        ? {
            ...c,
            status: "verified" as const,
            severity: "low" as const,
            note: `The page it cites (${c.sourceUrl}) names ${entity}. That the page names it is not proof of the claim, but the citation is on topic.`,
          }
        : {
            ...c,
            status: "unsupported" as const,
            severity: "medium" as const,
            note:
              `The cited page loaded and does not name ${entity}. Open ${c.sourceUrl} and check who it says ` +
              `regulates or pays for this, then correct the sentence or cut it.`,
          };
    }

    const missing = c.figures.filter((f) => !pageHasFigure(text, f, language));
    // The number is on the page, and the page's sentence carrying it is not
    // about the article's subject: the citation is real and proves nothing
    // here. Kept at
    // `needs_verification` rather than a status of its own, because that is
    // already the state every surface (review panel, auto-approve, evals)
    // reads as "a person decides"; a new status would need each of them to
    // learn it. It only stops a green tick: the verdict becomes `review`.
    if (missing.length === 0 && !figureOnTopic(sentences.get(c.sourceUrl!) ?? [], c, opts.topic, language)) {
      return {
        ...c,
        status: "needs_verification" as const,
        severity: "medium" as const,
        note:
          `The page it cites (${c.sourceUrl}) carries this figure, but in a sentence that is not about ` +
          `${opts.topic}. A figure about something else is not evidence for this article: cut it, ` +
          `or replace it with one about the subject.`,
      };
    }
    if (missing.length === 0) {
      return {
        ...c,
        status: "verified" as const,
        severity: "low" as const,
        note:
          `Every figure in this sentence appears on the page it cites ` +
          `(${c.sourceUrl}). That the page carries the number is not proof the ` +
          `number is right, but the citation is real.`,
      };
    }
    return {
      ...c,
      status: "contradicted" as const,
      severity: "high" as const,
      note:
        `The cited page loaded and does not contain ` +
        `${missing.map((f) => `"${f}"`).join(", ")}. ` +
        `Open ${c.sourceUrl}, correct the figure to what it actually says, or cut it.`,
    };
  });

  return summarise(claims, resolveLocale(language));
}

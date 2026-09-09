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
import type { ExtractedClaim, FactCheckReport } from "@/lib/ai/fact-check";
import { summarise } from "@/lib/ai/fact-check";

export type PageFetcher = (url: string) => Promise<{ status: number; body: string }>;

export interface VerifyCitationsOptions {
  fetcher?: PageFetcher;
  timeoutMs?: number;
  concurrency?: number;
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
export function readablePageText(html: string): string {
  return stripTags(html)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&#36;/g, "$")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Every way a page might write the same figure.
 *
 * "8%" and "8 percent" are the same claim; so are "$30,000", "30,000" and
 * "30000". A page that writes the number differently from the article has not
 * contradicted it, and matching only the article's spelling would report that
 * as a contradiction.
 */
export function figureVariants(figure: string): string[] {
  const raw = figure.trim().toLowerCase();
  const out = new Set<string>([raw]);

  const pct = raw.match(/^(\d+(?:[.,]\d+)?)\s*(?:%|percent|per cent)$/);
  if (pct) {
    const n = pct[1];
    out.add(`${n}%`);
    out.add(`${n} %`);
    out.add(`${n} percent`);
    out.add(`${n} per cent`);
  }

  const money = raw.match(/^([$€£])\s?([\d.,]+)$/);
  if (money) {
    const [, sign, digits] = money;
    const bare = digits.replace(/,/g, "");
    for (const d of new Set([digits, bare])) {
      out.add(`${sign}${d}`);
      out.add(`${sign} ${d}`);
      out.add(d);
    }
  }

  const plain = raw.match(/^[\d.,]+$/);
  if (plain) {
    out.add(raw.replace(/,/g, ""));
    // 30000 -> 30,000, so a bare number in the article still matches a page
    // that groups its thousands.
    const digits = raw.replace(/[.,]/g, "");
    if (digits.length > 3) out.add(digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  }

  return [...out].filter(Boolean);
}

/** Does the page carry this figure, written any of the usual ways? */
export function pageHasFigure(pageText: string, figure: string): boolean {
  return figureVariants(figure).some((v) => pageText.includes(v));
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
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetcher = opts.fetcher ?? defaultPageFetcher(timeoutMs);
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const checkable = report.claims.filter(
    (c) => c.status === "needs_verification" && c.sourceUrl && !isUnsafeHost(c.sourceUrl),
  );
  if (checkable.length === 0) return report;

  const urls = [...new Set(checkable.map((c) => c.sourceUrl!))];
  const pages = new Map<string, string | null>();

  const read = async (url: string): Promise<void> => {
    try {
      const { status, body } = await fetcher(url);
      const text = status >= 200 && status < 300 ? readablePageText(body) : "";
      pages.set(url, text.length >= MIN_READABLE_CHARS ? text : null);
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

    const missing = c.figures.filter((f) => !pageHasFigure(text, f));
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

  return summarise(claims);
}

// ---------------------------------------------------------------------------
// What is mechanically wrong with a page
// ---------------------------------------------------------------------------
//
// The wizard asks a new customer for their blog and says what it is for. Until
// now nothing read it: `detectLinks` harvested its URLs for the link pool, and
// the only thing that ever fetched the pages themselves was a nightly cron
// gated on `first_analysed_at`, so on day one we knew a customer had 204 posts
// and nothing about them. This is the day-one read.
//
// Deliberately technical, and deliberately not editorial. Every check below is
// a fact a program can establish from the bytes of one HTTP response - a status
// code, the length of a string, how many `<h1>` there are - and none of them is
// a judgement about whether the writing is any good. That line is the whole
// point: an opinion about someone's prose, delivered unasked in the first
// minute of their account, is a worse product than a list of nine pages with no
// meta description. The scorers next door (`scoreArticle`, `scoreCitationReadiness`,
// `auditArticle`) make the editorial judgements, need a keyword to do it, and
// are not on this path.
//
// It is also free. No model, no DataForSEO: `crawlPage` already fetches the
// HTML for `site_pages`, and every check here reads what that fetch returned.
// The marginal cost of the whole assessment is the regular expressions below.
//
// The thresholds are the boring industry ones (title 30-60, meta 70-160, an
// article under 300 words is thin). They are not tuned and they are not
// research; they are stated here as constants rather than buried so the number
// in the message and the number in the test are the same number.

/** Same three levels `AuditIssue` uses, so one vocabulary describes both. */
export type TechSeverity = "error" | "warning" | "info";

export type TechCheck =
  | "http_error"
  | "redirect_chain"
  | "tls_chain"
  | "title_missing"
  | "title_length"
  | "meta_description_missing"
  | "meta_description_length"
  | "h1_missing"
  | "h1_multiple"
  | "thin_content"
  | "canonical_missing"
  | "canonical_elsewhere"
  | "noindex"
  | "nofollow"
  | "images_missing_alt"
  | "no_internal_links"
  | "no_structured_data"
  | "open_graph_missing"
  | "duplicate_title"
  | "duplicate_meta_description";

export interface TechFinding {
  code: TechCheck;
  severity: TechSeverity;
  /** One sentence, naming the measured value. Rendered as-is. */
  message: string;
}

/** The thresholds, in one place, so the message and the test cannot drift. */
export const TECH_LIMITS = {
  titleMin: 30,
  titleMax: 60,
  metaMin: 70,
  metaMax: 160,
  /** Below this an article is thin. Only applied to `article` pages. */
  thinWords: 300,
  /** More hops than this to reach the page is worth reporting. */
  redirectHops: 1,
} as const;

/**
 * A label and a reason per check, for the table that renders these.
 *
 * The reason is what makes a list of codes usable: "Missing meta description"
 * says what, "Google writes its own snippet from the page instead" says why
 * anyone should care, in one clause, without claiming a ranking effect nobody
 * has measured.
 */
export const TECH_CHECK_INFO: Record<TechCheck, { label: string; why: string }> = {
  http_error: { label: "Page does not load", why: "The URL is in your sitemap but the server does not return it." },
  redirect_chain: { label: "Redirect chain", why: "Each hop is a round trip before anyone sees the page." },
  tls_chain: { label: "Incomplete certificate chain", why: "Browsers cope; crawlers and AI assistants often read the site as unreachable." },
  title_missing: { label: "No title", why: "The title is the line search results and AI answers use to name the page." },
  title_length: { label: "Title length", why: "Search results truncate a long title and pad out a short one." },
  meta_description_missing: { label: "No meta description", why: "Google writes its own snippet from the page instead of yours." },
  meta_description_length: { label: "Meta description length", why: "A description outside this range is cut off or padded in results." },
  h1_missing: { label: "No H1", why: "Nothing on the page states what it is about at the top level." },
  h1_multiple: { label: "More than one H1", why: "Two top-level headings leave the subject of the page ambiguous." },
  thin_content: { label: "Thin content", why: "There is not enough on the page to answer the question it is named after." },
  canonical_missing: { label: "No canonical link", why: "Nothing tells search engines which URL is the real one when several serve this page." },
  canonical_elsewhere: { label: "Canonical points elsewhere", why: "This page asks search engines to credit a different URL." },
  noindex: { label: "Marked noindex", why: "The page is in your sitemap and also tells search engines to leave it out." },
  nofollow: { label: "Marked nofollow", why: "Links on this page are not followed, so nothing it points at is discovered through it." },
  images_missing_alt: { label: "Images with no alt text", why: "Screen readers and image search have nothing to read." },
  no_internal_links: { label: "No internal links", why: "The page is a dead end: nothing leads from it to the rest of the site." },
  no_structured_data: { label: "No structured data", why: "No JSON-LD, so nothing states in machine-readable form what this page is." },
  open_graph_missing: { label: "No Open Graph tags", why: "Shared links show whatever the platform can guess." },
  duplicate_title: { label: "Duplicate title", why: "Several pages carry the same title, so they compete to be the same result." },
  duplicate_meta_description: { label: "Duplicate meta description", why: "Several pages describe themselves identically." },
};

/** One hop of a redirect chain, in the order the crawler walked it. */
export interface RedirectHop {
  status: number;
  from: string;
  to: string;
}

/**
 * Everything the checks read, extracted once per page.
 *
 * A plain data object on purpose: the checks below are pure functions of it,
 * so a test is a literal rather than a fixture server, and a future check that
 * needs a new fact adds a field here instead of a second parse.
 */
export interface TechFacts {
  url: string;
  /** Where the crawler ended up, which is `url` unless something redirected. */
  finalUrl: string;
  status: number;
  redirects: RedirectHop[];
  /** The chain could not be verified and was read anyway. */
  tlsUnverified: boolean;
  pageType: "article" | "listing" | "page";
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  wordCount: number;
  /** The `<link rel=canonical>` href, resolved against the page's own URL. */
  canonical: string | null;
  /** Robots directives from the meta tag and the `X-Robots-Tag` header, merged. */
  robotsDirectives: string[];
  images: number;
  imagesMissingAlt: number;
  internalLinks: number;
  externalLinks: number;
  jsonLdTypes: string[];
  /** Which `og:` properties the page carries. Presence only. */
  openGraph: string[];
}

// ── Extraction ──────────────────────────────────────────────────────────────

const OG_PROPERTIES = ["og:title", "og:description", "og:image", "og:type", "og:url"];

/** Every `<img>` on the page, and how many of them have no usable alt. */
export function countImages(html: string): { total: number; missingAlt: number } {
  let total = 0;
  let missingAlt = 0;
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1];
    total++;
    if (/\balt\s*=/i.test(attrs)) continue;
    // A decorative image is marked `alt=""` on purpose and that is correct
    // markup, not a defect; only a missing attribute counts. `aria-hidden` and
    // `role="presentation"` say the same thing a different way.
    if (/\baria-hidden\s*=\s*["']?true/i.test(attrs)) continue;
    if (/\brole\s*=\s*["']presentation["']/i.test(attrs)) continue;
    missingAlt++;
  }
  return { total, missingAlt };
}

/** The `<link rel="canonical">` href, resolved. Null when there is none. */
export function canonicalOf(html: string, pageUrl: string): string | null {
  const m =
    html.match(/<link\b[^>]*\brel\s*=\s*["']canonical["'][^>]*\bhref\s*=\s*["']([^"']*)["']/i) ??
    html.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*\brel\s*=\s*["']canonical["']/i);
  const href = m?.[1]?.trim();
  if (!href) return null;
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Robots directives that apply to us, from both places they can be written.
 *
 * `<meta name="robots">` and the `X-Robots-Tag` header are additive - a page
 * can be indexable in its markup and noindex in its headers, and the header
 * wins in practice - so both are read and merged. `googlebot` is read too: a
 * page that hides only from Google is still hidden.
 */
export function robotsDirectivesOf(html: string, headers: Record<string, string>): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined) => {
    for (const part of (value ?? "").split(",")) {
      const token = part.trim().toLowerCase();
      // `X-Robots-Tag: googlebot: noindex` names the agent before the rule.
      const rule = token.includes(":") ? token.split(":").pop()!.trim() : token;
      if (rule) out.add(rule);
    }
  };
  for (const name of ["robots", "googlebot"]) {
    const m =
      html.match(new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*\\bcontent\\s*=\\s*["']([^"']*)["']`, "i")) ??
      html.match(new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'][^>]*\\bname\\s*=\\s*["']${name}["']`, "i"));
    add(m?.[1]);
  }
  add(headers["x-robots-tag"]);
  return [...out];
}

/** Which Open Graph properties the page declares. Presence, not quality. */
export function openGraphOf(html: string): string[] {
  return OG_PROPERTIES.filter((prop) =>
    new RegExp(`<meta\\b[^>]*\\bproperty\\s*=\\s*["']${prop}["']`, "i").test(html),
  );
}

/** How many `<h1>` the page opens. Two is a finding; the count is the message. */
export function countH1(html: string): number {
  return [...html.matchAll(/<h1\b[^>]*>/gi)].length;
}

// ── The checks ──────────────────────────────────────────────────────────────

/** Two URLs that differ only in trailing slash, scheme case or a `www.` are one. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const url = new URL(u);
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();
    } catch {
      return u.replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * Everything mechanically wrong with one page.
 *
 * A page that did not load gets exactly one finding: nothing else can be
 * established about it, and reporting "no title, no H1, no meta description"
 * about a 404 would be three true statements that all mean the same thing and
 * bury the one that matters.
 */
export function checkPage(facts: TechFacts): TechFinding[] {
  const out: TechFinding[] = [];
  const add = (code: TechCheck, severity: TechSeverity, message: string) =>
    out.push({ code, severity, message });

  if (facts.status === 0 || facts.status >= 400) {
    add(
      "http_error",
      "error",
      facts.status === 0
        ? "The server did not answer for this URL."
        : `The server returned ${facts.status} for this URL.`,
    );
    return out;
  }

  if (facts.tlsUnverified) {
    add("tls_chain", "warning", "The certificate chain is incomplete, so the page was read without verifying it.");
  }

  if (facts.redirects.length > TECH_LIMITS.redirectHops) {
    add(
      "redirect_chain",
      "warning",
      `${facts.redirects.length} redirects before this page loads, ending at ${facts.finalUrl}.`,
    );
  } else if (facts.redirects.length === 1) {
    add("redirect_chain", "info", `Your sitemap lists a URL that redirects to ${facts.finalUrl}.`);
  }

  // --- what the page says it is -------------------------------------------
  const title = facts.title?.trim() ?? "";
  if (!title) {
    add("title_missing", "error", "This page has no title.");
  } else if (title.length < TECH_LIMITS.titleMin) {
    add("title_length", "info", `The title is ${title.length} characters; under ${TECH_LIMITS.titleMin} leaves room unused.`);
  } else if (title.length > TECH_LIMITS.titleMax) {
    add("title_length", "info", `The title is ${title.length} characters and is cut off past about ${TECH_LIMITS.titleMax}.`);
  }

  const meta = facts.metaDescription?.trim() ?? "";
  if (!meta) {
    add("meta_description_missing", "warning", "This page has no meta description.");
  } else if (meta.length < TECH_LIMITS.metaMin) {
    add("meta_description_length", "info", `The meta description is ${meta.length} characters; under ${TECH_LIMITS.metaMin} leaves room unused.`);
  } else if (meta.length > TECH_LIMITS.metaMax) {
    add("meta_description_length", "info", `The meta description is ${meta.length} characters and is cut off past about ${TECH_LIMITS.metaMax}.`);
  }

  if (facts.h1Count === 0) add("h1_missing", "warning", "This page has no H1.");
  else if (facts.h1Count > 1) add("h1_multiple", "info", `This page has ${facts.h1Count} H1 headings.`);

  // Only writing can be thin. A pricing page in forty words is a pricing page.
  if (facts.pageType === "article" && facts.wordCount < TECH_LIMITS.thinWords) {
    add("thin_content", "warning", `${facts.wordCount.toLocaleString()} words, under the ${TECH_LIMITS.thinWords} an article usually needs.`);
  }

  // --- what the page tells crawlers ---------------------------------------
  if (facts.robotsDirectives.includes("noindex") || facts.robotsDirectives.includes("none")) {
    add("noindex", "error", "This page is in your sitemap and also tells search engines not to index it.");
  }
  if (facts.robotsDirectives.includes("nofollow")) {
    add("nofollow", "info", "Links on this page are marked nofollow.");
  }

  if (!facts.canonical) {
    add("canonical_missing", "info", "No canonical link, so nothing states which URL is the real one.");
  } else if (!sameUrl(facts.canonical, facts.finalUrl)) {
    add("canonical_elsewhere", "warning", `The canonical link points at ${facts.canonical}, not at this page.`);
  }

  // --- what the page carries ----------------------------------------------
  if (facts.imagesMissingAlt > 0) {
    add(
      "images_missing_alt",
      "warning",
      `${facts.imagesMissingAlt} of ${facts.images} image${facts.images === 1 ? "" : "s"} have no alt text.`,
    );
  }
  if (facts.internalLinks === 0) {
    add("no_internal_links", "warning", "Nothing on this page links anywhere else on the site.");
  }
  if (facts.jsonLdTypes.length === 0) {
    add("no_structured_data", "info", "No JSON-LD on this page.");
  }
  if (facts.openGraph.length === 0) {
    add("open_graph_missing", "info", "No Open Graph tags, so a shared link has nothing to show.");
  }

  return out;
}

// ── Across the site ─────────────────────────────────────────────────────────

/** The shape the duplicate pass needs: one entry per page that answered. */
export interface DuplicateInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  status: number;
}

/**
 * Titles and descriptions that appear on more than one page.
 *
 * Only over the pages this run read. On a site inside the page cap that is the
 * whole site; past the cap it is a subset, and the caller says so rather than
 * this pretending otherwise. Blank values are not duplicates of each other -
 * "no title" is already its own finding and reporting forty pages as duplicates
 * of one another because none of them has a title is noise.
 */
export function duplicateFindings(pages: DuplicateInput[]): Map<string, TechFinding[]> {
  const out = new Map<string, TechFinding[]>();
  const push = (url: string, finding: TechFinding) => {
    const list = out.get(url);
    if (list) list.push(finding);
    else out.set(url, [finding]);
  };

  const live = pages.filter((p) => p.status >= 200 && p.status < 400);

  const group = (pick: (p: DuplicateInput) => string | null) => {
    const byValue = new Map<string, string[]>();
    for (const p of live) {
      const value = pick(p)?.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      const urls = byValue.get(key);
      if (urls) urls.push(p.url);
      else byValue.set(key, [p.url]);
    }
    return [...byValue.values()].filter((urls) => urls.length > 1);
  };

  for (const urls of group((p) => p.title)) {
    for (const url of urls) {
      push(url, {
        code: "duplicate_title",
        severity: "warning",
        message: `${urls.length} pages share this title.`,
      });
    }
  }
  for (const urls of group((p) => p.metaDescription)) {
    for (const url of urls) {
      push(url, {
        code: "duplicate_meta_description",
        severity: "warning",
        message: `${urls.length} pages share this meta description.`,
      });
    }
  }

  return out;
}

// ── Summing up ──────────────────────────────────────────────────────────────

export interface TechSummary {
  /** Pages that answered and were checked. */
  pages: number;
  /** Of those, how many carry at least one finding. */
  pagesWithIssues: number;
  findings: number;
  errors: number;
  warnings: number;
  infos: number;
  /** Every check that fired, commonest first, with how many pages it hit. */
  byCheck: Array<{ code: TechCheck; pages: number; severity: TechSeverity }>;
}

/** Roll per-page findings up into the numbers a phase line and a card report. */
export function summarise(perPage: Array<{ findings: TechFinding[] }>): TechSummary {
  const byCheck = new Map<TechCheck, { pages: number; severity: TechSeverity }>();
  let findings = 0;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let pagesWithIssues = 0;

  for (const page of perPage) {
    if (page.findings.length) pagesWithIssues++;
    const seen = new Set<TechCheck>();
    for (const f of page.findings) {
      findings++;
      if (f.severity === "error") errors++;
      else if (f.severity === "warning") warnings++;
      else infos++;
      if (seen.has(f.code)) continue;
      seen.add(f.code);
      const entry = byCheck.get(f.code);
      if (entry) entry.pages++;
      else byCheck.set(f.code, { pages: 1, severity: f.severity });
    }
  }

  const RANK: Record<TechSeverity, number> = { error: 0, warning: 1, info: 2 };
  return {
    pages: perPage.length,
    pagesWithIssues,
    findings,
    errors,
    warnings,
    infos,
    byCheck: [...byCheck.entries()]
      .map(([code, v]) => ({ code, pages: v.pages, severity: v.severity }))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.pages - a.pages),
  };
}

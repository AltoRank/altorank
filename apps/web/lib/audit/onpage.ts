// ---------------------------------------------------------------------------
// DataForSEO On-Page: the pages our own fetch cannot read
// ---------------------------------------------------------------------------
//
// Our crawler is a GET and a set of regexes. That is the right default - it is
// free, it is fast, and it returns real HTML with the anchors intact, which is
// what the scorers need. It has one blind spot, and it is total: a site that
// renders its content in the browser hands back an empty shell, and
// `analyseDomain` reports "no pages could be crawled". For those prospects the
// entire first look is blank.
//
// This is the fallback. DataForSEO runs a real browser, so a client-rendered
// page comes back with its title, headings, link counts and 52 on-page checks.
//
// COST, and why this is not the default. Measured 2026-09-04:
//
//   instant_pages, no JS      $0.00015 per page
//   instant_pages, with JS    $0.0051  per page   (34x - it is a browser)
//
// So 204 pages of fitsuite.co cost 3 cents our way and $1.04 rendered. The
// rule this module encodes: try the free path, and pay only for the pages it
// could not read.
//
// What it does NOT give is HTML. `meta.content` is counts and statistics, not
// markup, so a page recovered this way can be described but not scored the way
// a fetched page is - the GEO checks need to see headings, tables and anchors.
// Callers must treat a rendered page as "we know what it is" rather than "we
// know how good it is", and say so rather than storing a score built on less.

import { post } from "@/lib/seo/client";

const ENDPOINT = "/on_page/instant_pages";

export interface OnPageFacts {
  url: string;
  statusCode: number;
  /** DataForSEO's own 0-100 on-page score, from its 52 checks. */
  onPageScore: number | null;
  title: string | null;
  titleLength: number | null;
  description: string | null;
  descriptionLength: number | null;
  canonical: string | null;
  h1: string[];
  h2: string[];
  wordCount: number | null;
  internalLinks: number | null;
  externalLinks: number | null;
  imagesCount: number | null;
  brokenLinks: number | null;
  brokenResources: number | null;
  /** True when the site serves this same title/description/body elsewhere. */
  duplicateTitle: boolean;
  duplicateDescription: boolean;
  duplicateContent: boolean;
  /** Clicks from the homepage. High numbers are pages Google rarely reaches. */
  clickDepth: number | null;
  cumulativeLayoutShift: number | null;
  /**
   * Every check whose boolean came back true, raw.
   *
   * NOT the failures. A check's polarity is part of its name and the two
   * kinds are mixed: `is_https` true means the page IS served over HTTPS,
   * `no_image_alt` true means images ARE missing alt text. A page in good
   * health has a long list here. Use `faults`.
   */
  checksTrue: string[];
  /** The subset of `checksTrue` that are actually problems. */
  faults: string[];
  /** Whether a browser was used, which is what the extra cost bought. */
  rendered: boolean;
}

interface InstantPagesItem {
  url?: string;
  status_code?: number;
  onpage_score?: number;
  click_depth?: number;
  broken_links?: number;
  broken_resources?: number;
  duplicate_title?: boolean;
  duplicate_description?: boolean;
  duplicate_content?: boolean;
  checks?: Record<string, boolean>;
  meta?: {
    title?: string;
    title_length?: number;
    description?: string;
    description_length?: number;
    canonical?: string;
    cumulative_layout_shift?: number;
    internal_links_count?: number;
    external_links_count?: number;
    images_count?: number;
    htags?: Record<string, string[]>;
    content?: { plain_text_word_count?: number };
  };
}

/**
 * Read one page through DataForSEO's crawler.
 *
 * `javascript` runs a real browser and costs 34x, so it is off unless the
 * caller has already established that the free path returns nothing.
 */
export async function fetchInstantPage(
  url: string,
  opts: { javascript?: boolean } = {},
): Promise<OnPageFacts | null> {
  const javascript = opts.javascript ?? false;

  const res = await post<{ items?: InstantPagesItem[] }>(ENDPOINT, [
    {
      url,
      enable_javascript: javascript,
      ...(javascript ? { enable_browser_rendering: true } : {}),
    },
  ]);

  const item = res.tasks?.[0]?.result?.[0]?.items?.[0];
  if (!item) return null;

  const meta = item.meta ?? {};
  const htags = meta.htags ?? {};
  const trueChecks = Object.entries(item.checks ?? {})
    .filter(([, value]) => value)
    .map(([name]) => name)
    .sort();

  return {
    url: item.url ?? url,
    statusCode: item.status_code ?? 0,
    onPageScore: num(item.onpage_score),
    title: meta.title?.trim() || null,
    titleLength: num(meta.title_length),
    description: meta.description?.trim() || null,
    descriptionLength: num(meta.description_length),
    canonical: meta.canonical?.trim() || null,
    h1: htags.h1 ?? [],
    h2: htags.h2 ?? [],
    wordCount: num(meta.content?.plain_text_word_count),
    internalLinks: num(meta.internal_links_count),
    externalLinks: num(meta.external_links_count),
    imagesCount: num(meta.images_count),
    brokenLinks: num(item.broken_links),
    brokenResources: num(item.broken_resources),
    duplicateTitle: Boolean(item.duplicate_title),
    duplicateDescription: Boolean(item.duplicate_description),
    duplicateContent: Boolean(item.duplicate_content),
    clickDepth: num(item.click_depth),
    cumulativeLayoutShift: num(meta.cumulative_layout_shift),
    checksTrue: trueChecks,
    faults: trueChecks.filter((name) => FAULTS.has(name)),
    rendered: javascript,
  };
}

/** Null rather than 0 for an absent number: unmeasured is not zero. */
function num(v: number | undefined): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * The checks that describe a problem when true.
 *
 * DataForSEO mixes two kinds under one key and the polarity lives only in the
 * name: `is_https`, `canonical`, `has_html_doctype` and the four
 * `seo_friendly_url` checks are true when the page is HEALTHY, while
 * `no_image_alt` and `low_content_rate` are true when it is not. Observed on
 * fitsuite.co: 50 of 50 pages reported `is_https` true and 49 reported
 * `canonical` true, which read as a site where everything is broken if the
 * set is taken at face value.
 *
 * An allowlist rather than a rule over names. "is_broken" and "is_https" are
 * both `is_`, and guessing wrong in either direction produces confident
 * nonsense - either a healthy site described as failing, or a real fault
 * silently dropped.
 */
const FAULTS = new Set<string>([
  "no_h1_tag", "no_title", "no_description", "no_favicon", "no_image_alt",
  "no_image_title", "no_content_encoding", "no_doctype",
  "title_too_long", "title_too_short", "title_too_short_or_long",
  "duplicate_title_tag", "duplicate_description_tag", "duplicate_content",
  "low_content_rate", "low_readability_rate", "low_character_count",
  "small_page_size", "large_page_size", "high_loading_time",
  "has_render_blocking_resources", "deprecated_html_tags",
  "redirect_chain", "canonical_to_redirect", "canonical_chain",
  "is_broken", "is_4xx_code", "is_5xx_code", "is_orphan_page",
  "irrelevant_description", "irrelevant_title", "irrelevant_meta_keywords",
  "broken_links", "broken_resources", "lorem_ipsum",
  "no_favicon_touch_icon", "recursive_canonical", "https_to_http_links",
]);

/**
 * The checks worth showing a human, in the words they would use.
 *
 * DataForSEO returns 52, many of which are duplicates of each other or
 * describe the same fault from two angles ("seo_friendly_url" and its four
 * sub-checks). Naming the ones that matter keeps the audit readable and keeps
 * a raw provider identifier out of the interface.
 */
export const CHECK_LABEL: Record<string, string> = {
  no_h1_tag: "No H1",
  no_title: "No title",
  title_too_long: "Title too long for a result line",
  title_too_short: "Title shorter than the space available",
  no_description: "No meta description",
  no_image_alt: "Images without alt text",
  no_favicon: "No favicon",
  duplicate_title_tag: "Title used on another page too",
  duplicate_description_tag: "Meta description used on another page too",
  duplicate_content: "Body duplicated elsewhere on the site",
  low_content_rate: "Mostly markup, little text",
  low_readability_rate: "Hard to read",
  small_page_size: "Very little on the page",
  large_page_size: "Page is heavy",
  has_render_blocking_resources: "Scripts or styles block the first paint",
  redirect_chain: "Reached through a chain of redirects",
  canonical_to_redirect: "Canonical points at a redirect",
  canonical_chain: "Canonical points at another canonical",
  is_broken: "Page is broken",
  is_4xx_code: "Returns a 4xx",
  is_5xx_code: "Returns a 5xx",
  is_orphan_page: "Nothing on the site links here",
  is_www: "Serves on www and bare domain both",
  no_content_encoding: "Served uncompressed",
  high_loading_time: "Slow to load",
  irrelevant_description: "Meta description does not match the page",
  irrelevant_title: "Title does not match the page",
  deprecated_html_tags: "Uses deprecated HTML",
  no_doctype: "No doctype",
  seo_friendly_url: "URL is not readable",
  broken_links: "Contains a link that is broken",
  broken_resources: "An image, script or stylesheet is missing",
};

/** Only the faults we have words for, so nothing surfaces a raw identifier. */
export function describeFailing(facts: OnPageFacts): Array<{ id: string; label: string }> {
  return facts.faults
    .filter((id) => CHECK_LABEL[id])
    .map((id) => ({ id, label: CHECK_LABEL[id] }));
}

/** Whether a named check describes a problem when true. Exported for the crawl. */
export function isFault(check: string): boolean {
  return FAULTS.has(check);
}

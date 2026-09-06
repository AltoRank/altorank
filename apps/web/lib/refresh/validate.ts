// ---------------------------------------------------------------------------
// Checks on a rewrite before a person sees it
// ---------------------------------------------------------------------------
//
// The rewrite prompt asks the model to keep structure, links and images and
// to write plainly. A prompt is a request; these are the checks. They run
// once when the execution is created and are shown beside the diff, so the
// reviewer opens the page already knowing "two images went missing" rather
// than having to count.
//
// Warnings, not blocks: the reviewer can still keep the hunks that are fine.
// The one hard rule - nothing reaches the site without a person - is enforced
// elsewhere (the push action), not here.

import { extractLinks } from "@/lib/seo/links";
import { BANNED_PHRASES } from "@/lib/ai/prompts";
import type { ValidationIssue } from "./types";

export interface ValidateOptions {
  siteDomain: string | null | undefined;
  /**
   * Paths the site is known to have (from `site_pages` and live articles).
   * A new internal link to something not in this set and not in the original
   * is flagged: the model may have invented a page.
   */
  knownPaths?: ReadonlySet<string>;
}

const pathOf = (href: string): string => {
  try {
    return new URL(href, "https://x.invalid").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return href;
  }
};

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const words = (html: string) =>
  html.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;

export function validateRewrite(
  beforeHtml: string,
  afterHtml: string,
  opts: ValidateOptions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Headings: a rewrite that flattened the structure is not a refresh.
  if (count(afterHtml, /<h2\b/gi) === 0) {
    issues.push({
      code: "no_headings",
      message: "The rewrite has no H2 headings; the original structure was not preserved.",
      severity: "error",
    });
  }

  // Images: the prompt says keep them; count them.
  const imgBefore = count(beforeHtml, /<img\b/gi);
  const imgAfter = count(afterHtml, /<img\b/gi);
  if (imgAfter < imgBefore) {
    issues.push({
      code: "images_dropped",
      message: `${imgBefore - imgAfter} of ${imgBefore} images are missing from the rewrite.`,
      severity: "warn",
    });
  }

  // Internal links: none lost, none invented.
  const before = extractLinks(beforeHtml, opts.siteDomain).filter((l) => l.kind === "internal");
  const after = extractLinks(afterHtml, opts.siteDomain).filter((l) => l.kind === "internal");
  const beforePaths = new Set(before.map((l) => pathOf(l.href)));
  const afterPaths = new Set(after.map((l) => pathOf(l.href)));
  const lost = [...beforePaths].filter((p) => !afterPaths.has(p));
  if (lost.length) {
    issues.push({
      code: "links_dropped",
      message: `${lost.length} internal ${lost.length === 1 ? "link" : "links"} from the original ${lost.length === 1 ? "is" : "are"} gone: ${lost.slice(0, 3).join(", ")}${lost.length > 3 ? "…" : ""}`,
      severity: "warn",
    });
  }
  if (opts.knownPaths) {
    const unknown = [...afterPaths].filter((p) => !beforePaths.has(p) && !opts.knownPaths!.has(p));
    if (unknown.length) {
      issues.push({
        code: "unknown_internal_link",
        message: `${unknown.length} new internal ${unknown.length === 1 ? "link points" : "links point"} at a page this site is not known to have: ${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}`,
        severity: "error",
      });
    }
  }
  const dead = extractLinks(afterHtml, opts.siteDomain).filter((l) => l.kind === "dead" || l.kind === "placeholder");
  if (dead.length) {
    issues.push({
      code: "dead_links",
      message: `${dead.length} ${dead.length === 1 ? "link goes" : "links go"} nowhere (empty, "#" or an unresolved placeholder).`,
      severity: "error",
    });
  }

  // Length: a refresh should not lose a third of the page.
  const wb = words(beforeHtml);
  const wa = words(afterHtml);
  if (wb > 0 && wa < wb * 0.7) {
    issues.push({
      code: "shorter",
      message: `The rewrite is ${wa.toLocaleString()} words against ${wb.toLocaleString()} before, a ${Math.round((1 - wa / wb) * 100)}% cut.`,
      severity: "warn",
    });
  }

  // The register that reads as machine-written. Same list the prompt bans.
  const text = afterHtml.replace(/<[^>]*>/g, " ").toLowerCase();
  const hits = BANNED_PHRASES.filter((p) => text.includes(p.toLowerCase()));
  if (hits.length) {
    issues.push({
      code: "ai_fluff",
      message: `Phrases the brief bans appear in the rewrite: ${hits.slice(0, 4).map((h) => `"${h}"`).join(", ")}${hits.length > 4 ? "…" : ""}`,
      severity: "warn",
    });
  }

  return issues;
}

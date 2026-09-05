// ---------------------------------------------------------------------------
// Citations belong in the sentence that makes the claim
// ---------------------------------------------------------------------------
//
// A "Sources" list at the foot of an article is where a citation goes to be
// ignored. A reader checks a figure where they read it or not at all, and an
// answer engine lifts one passage, not a page: a link three screens below the
// passage travels with neither. The prompt tells the writer to link inline;
// this is the check that it did.
//
// It is deliberately narrow. A footer existing is not the finding - a
// further-reading list is a reasonable thing to write. The finding is a URL
// that is ONLY in the footer, because that is a claim somewhere above with its
// evidence detached from it. Pure and offline, so the audit panel can run it
// on every keystroke.

import { decodeEntities } from "@/lib/audit/html-utils";
import { classifyHref, extractLinks } from "@/lib/seo/links";

/**
 * Whole-heading labels that open a citation list, in the languages the
 * product writes in. Matched exactly rather than by prefix so a real section
 * called "Sources of traffic" is not mistaken for a footer.
 */
const FOOTER_LABELS = new Set([
  "sources", "source", "references", "reference", "citations", "bibliography",
  "works cited", "further reading", "sources and references", "sources & references",
  "references and sources", "sources cited",
  "fonti", "riferimenti", "bibliografia", "fonti e riferimenti", "note e fonti",
  "fuentes", "referencias", "fuentes y referencias",
  "références", "sources et références",
  "quellen", "literatur", "quellenverzeichnis", "literaturverzeichnis", "quellen und literatur",
]);

export interface SourcesFooter {
  /** The label as written, lowercased, without its trailing colon. */
  label: string;
  /** Heading level, or null when the label was a bold paragraph rather than a heading. */
  level: number | null;
  /** Offsets into the HTML: the label's start and the footer's end. */
  start: number;
  end: number;
}

export interface CitationRef {
  href: string;
  /** The link's visible text, or the URL itself when it was written bare. */
  anchor: string;
}

export interface InlineCitationReport {
  footer: SourcesFooter | null;
  /** Outbound URLs listed in the footer. */
  footerUrls: CitationRef[];
  /** Footer URLs that appear nowhere in the body: claims whose evidence is detached. */
  orphaned: CitationRef[];
}

function labelOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:.]+$/, "")
    .toLowerCase();
}

/**
 * The citation list at the end of an article, if there is one.
 *
 * A heading (H2 to H4) or a paragraph that is only the label
 * (`<p><strong>Sources:</strong></p>`) opens it. The last match wins, since
 * a writer who opens a "Sources" section opens it once, at the end. It runs to
 * the next heading at the same level or above, or to the end of the document,
 * so a FAQ that follows it is not swallowed.
 */
export function findSourcesFooter(html: string): SourcesFooter | null {
  let found: { label: string; level: number | null; start: number; headingEnd: number } | null = null;
  for (const m of html.matchAll(/<(h[2-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const label = labelOf(m[2]);
    if (!FOOTER_LABELS.has(label)) continue;
    const tag = m[1].toLowerCase();
    const start = m.index ?? 0;
    found = {
      label,
      level: tag === "p" ? null : Number(tag[1]),
      start,
      headingEnd: start + m[0].length,
    };
  }
  if (!found) return null;

  // A paragraph label has no level of its own, so any heading closes it.
  const closesAt = found.level ?? 6;
  const rest = html.slice(found.headingEnd);
  const next = [...rest.matchAll(/<h([1-6])\b/gi)].find((h) => Number(h[1]) <= closesAt);
  const end = next ? found.headingEnd + (next.index ?? 0) : html.length;
  return { label: found.label, level: found.level, start: found.start, end };
}

/**
 * One URL in the form two spellings of the same page share: no fragment, no
 * tracking parameters, no trailing slash, no `www.`, one scheme. A writer who
 * links `https://www.site.org/report/` inline and lists
 * `http://site.org/report?utm_source=x#top` below has cited one source.
 */
export function canonicalUrl(href: string): string {
  try {
    const u = new URL(href.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key)) u.searchParams.delete(key);
    }
    return u
      .toString()
      .replace(/^https?:\/\/(?:www\.)?/i, "https://")
      .replace(/\/$/, "")
      .toLowerCase();
  } catch {
    return href.trim().toLowerCase();
  }
}

/**
 * Every outbound URL in a fragment: linked ones by href, plus any written
 * bare in the text, because a footer that reads "1. https://site.org/report"
 * is still listing a source even when the writer forgot the anchor.
 */
function externalRefs(fragment: string, siteDomain: string | null | undefined): CitationRef[] {
  const refs: CitationRef[] = extractLinks(fragment, siteDomain)
    .filter((l) => l.kind === "external")
    .map((l) => ({ href: l.href, anchor: l.anchor || l.href }));
  const text = decodeEntities(fragment.replace(/<[^>]*>/g, " "));
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const href = m[0].replace(/[.,;:]+$/, "");
    if (classifyHref(href, siteDomain) === "external") refs.push({ href, anchor: href });
  }
  return refs;
}

function dedupe(refs: CitationRef[]): CitationRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = canonicalUrl(r.href);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Which footer citations never appear at a claim.
 *
 * With no footer there is nothing to check and the report says so; the
 * `unsourced-figures` audit already covers a body that cites nothing at all.
 */
export function checkInlineCitations(
  html: string,
  siteDomain?: string | null,
): InlineCitationReport {
  const footer = findSourcesFooter(html);
  if (!footer) return { footer: null, footerUrls: [], orphaned: [] };

  const footerHtml = html.slice(footer.start, footer.end);
  const body = html.slice(0, footer.start) + html.slice(footer.end);
  const footerUrls = dedupe(externalRefs(footerHtml, siteDomain));
  const inline = new Set(externalRefs(body, siteDomain).map((r) => canonicalUrl(r.href)));
  const orphaned = footerUrls.filter((r) => !inline.has(canonicalUrl(r.href)));
  return { footer, footerUrls, orphaned };
}

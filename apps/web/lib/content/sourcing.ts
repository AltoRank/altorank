// ---------------------------------------------------------------------------
// Sourcing pass: a draft should not arrive in review already refused
// ---------------------------------------------------------------------------
//
// `approvalBlocker` (lib/ai/fact-check.ts) refuses approval of any draft that
// still carries a bare, unattributed figure. That gate is right and stays. What
// was wrong is that the pipeline handed the reviewer drafts that failed it and
// said nothing: the article was written, checked, marked `high_risk` and filed
// under "waiting for your yes" on a screen whose only button could not work.
//
// So the check runs before the draft lands, and what it finds is fixed rather
// than reported. Three moves, in order of how much of the author's intent they
// keep:
//
//   1. Source it.   The figure appears in a page the research already read, so
//                   link the figure to that page. Nothing is invented: the URL
//                   was in the SERP, and it is fetched once before it is used.
//   2. Rewrite it.  Hand the paragraph back to the model with one instruction:
//                   say this without the bare number. The result is accepted
//                   only if the figures are actually gone and every link and
//                   image survived.
//   3. Cut it.      Delete the sentence. Last, because it loses a claim the
//                   writer meant to make, and still better than shipping a
//                   number nobody can stand behind.
//
// Both 1 and 2 are optional capabilities: with no research and no rewriter -
// a self-hosted install with no SERP provider, or the e2e fixtures - the pass
// degrades to 3 and still leaves a draft that can be approved.
//
// Nothing here weakens the gate. The pass ends by re-running the same check on
// what it produced, and that report is what gets stored, so the panel, the
// list and the refusal all read the same evidence.

import { factCheckArticle, type ExtractedClaim, type FactCheckReport } from "@/lib/ai/fact-check";
import { decodeEntities } from "@/lib/audit/html-utils";
import type { ArticleResearch } from "@/lib/seo/research";

/** Rewrite one block of article HTML so the listed figures are gone. */
export type BlockRewriter = (input: {
  html: string;
  figures: string[];
  language?: string | null;
}) => Promise<string | null>;

/** Answer whether a URL is worth linking to. Called at most once per URL. */
export type UrlVerifier = (url: string) => Promise<boolean>;

export interface SourcingOptions {
  research?: ArticleResearch;
  rewrite?: BlockRewriter;
  verifyUrl?: UrlVerifier;
  language?: string | null;
}

export interface SourcingOutcome {
  html: string;
  /** The check of the HTML this returns, not of the HTML it was given. */
  report: FactCheckReport;
  /** Figures linked to a page the research had already read. */
  sourced: number;
  /** Blocks the model rewrote to drop a figure. */
  rewritten: number;
  /** Sentences (or, when a sentence could not be isolated, blocks) removed. */
  cut: number;
}

// ── HTML with an offset map ────────────────────────────────────────────────
//
// The fact checker reports a *sentence*, as plain text with entities decoded
// and tags replaced by spaces. To act on that sentence the HTML offsets it came
// from are needed, so the text is rebuilt here alongside a span per character.
// A character produced by a tag has no span and is never deleted, which is what
// keeps `<strong>` from being cut in half.

type Span = { start: number; end: number } | null;

interface Mapped {
  text: string;
  spans: Span[];
}

const ENTITY = /^&#?[a-zA-Z0-9]{1,10};/;

export function mapHtmlText(html: string): Mapped {
  const chars: string[] = [];
  const spans: Span[] = [];
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const close = html.indexOf(">", i);
      const end = close === -1 ? html.length : close + 1;
      chars.push(" ");
      spans.push(null);
      i = end;
      continue;
    }
    if (ch === "&") {
      const m = ENTITY.exec(html.slice(i, i + 12));
      if (m) {
        const decoded = decodeEntities(m[0]);
        for (let k = 0; k < decoded.length; k += 1) {
          chars.push(decoded[k]);
          spans.push(k === 0 ? { start: i, end: i + m[0].length } : null);
        }
        i += m[0].length;
        continue;
      }
    }
    chars.push(ch);
    spans.push({ start: i, end: i + 1 });
    i += 1;
  }
  return { text: chars.join(""), spans };
}

/** Whitespace-collapsed view of a string, with an index back into it. */
function collapse(s: string): { norm: string; at: number[] } {
  const out: string[] = [];
  const at: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i += 1) {
    if (/\s/.test(s[i])) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out.push(" ");
      at.push(i);
      pendingSpace = false;
    }
    out.push(s[i]);
    at.push(i);
  }
  return { norm: out.join(""), at };
}

/**
 * Where `needle` sits in `haystack`, ignoring how the whitespace was written.
 *
 * The checker's sentence has been through `stripTags`, which turns every tag
 * into a space, so an exact match against the reconstructed text fails on any
 * sentence that contains a `<em>`. Comparing the collapsed forms does not.
 */
export function locateText(haystack: string, needle: string): { start: number; end: number } | null {
  const h = collapse(haystack);
  const n = collapse(needle);
  if (!n.norm) return null;
  const pos = h.norm.indexOf(n.norm);
  if (pos === -1) return null;
  return { start: h.at[pos], end: h.at[pos + n.norm.length - 1] + 1 };
}

/** Drop a range of plain text from the HTML it came from, leaving tags alone. */
function cutRange(html: string, mapped: Mapped, start: number, end: number): string {
  const spans = mapped.spans.slice(start, end).filter((s): s is NonNullable<Span> => s !== null);
  if (spans.length === 0) return html;
  // Back to front so earlier offsets stay valid.
  let out = html;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    out = out.slice(0, spans[i].start) + out.slice(spans[i].end);
  }
  return out;
}

/** The HTML range a plain-text range occupies, when it is one unbroken run. */
function htmlRange(mapped: Mapped, start: number, end: number): { start: number; end: number } | null {
  const spans = mapped.spans.slice(start, end);
  if (spans.some((s) => s === null)) return null;
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

// ── Blocks ─────────────────────────────────────────────────────────────────
//
// The pass works one block at a time: the fact checker's own unit is the block,
// a rewrite that sees a whole paragraph keeps its sense, and an edit confined to
// one element cannot corrupt the rest of the document.

const BLOCK_TAG = /<(table|p|h[1-6]|li|blockquote|figcaption)\b[^>]*>[\s\S]*?<\/\1>/gi;

interface BlockRef {
  /** Offsets of the whole element in the article HTML. */
  start: number;
  end: number;
  html: string;
}

/**
 * Top-level blocks, outermost first.
 *
 * A `<table>` is taken whole (the checker flattens one into a single block, so
 * a pricing table is one decision) and the `<td>`s inside it are not visited
 * again. Same for a `<li>` inside a `<blockquote>`.
 */
export function topLevelBlocks(html: string): BlockRef[] {
  const out: BlockRef[] = [];
  BLOCK_TAG.lastIndex = 0;
  for (const m of html.matchAll(BLOCK_TAG)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (out.some((b) => start >= b.start && end <= b.end)) continue;
    out.push({ start, end, html: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── Sourcing from the research ─────────────────────────────────────────────

interface Candidate {
  url: string;
  domain: string;
}

/**
 * A page the research already read that states this exact figure.
 *
 * The same test `factCheckArticle` calls corroboration: the figure appears in
 * the title or snippet of a page that ranks for the keyword, or in a page
 * Google's own AI overview cited. That is not proof the figure is true, and
 * this does not claim it is - it puts the reader one click from the page that
 * says it, which is the whole of what a citation does.
 */
export function candidateSource(figure: string, research?: ArticleResearch): Candidate | null {
  if (!research) return null;
  const needle = figure.trim().toLowerCase();
  if (needle.length < 2) return null;
  for (const c of research.competitors) {
    if (!/^https?:\/\//i.test(c.url)) continue;
    if (`${c.title} ${c.description}`.toLowerCase().includes(needle)) {
      return { url: c.url, domain: c.domain };
    }
  }
  for (const c of research.aiOverview?.citations ?? []) {
    if (!/^https?:\/\//i.test(c.url)) continue;
    if (`${c.title} ${research.aiOverview?.markdown ?? ""}`.toLowerCase().includes(needle)) {
      return { url: c.url, domain: c.domain };
    }
  }
  return null;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** True when the offset sits inside an `<a>…</a>` that is already open. */
function insideAnchor(html: string, offset: number): boolean {
  const before = html.slice(0, offset);
  const opens = (before.match(/<a\b/gi) ?? []).length;
  const closes = (before.match(/<\/a>/gi) ?? []).length;
  return opens > closes;
}

/**
 * Wrap the first occurrence of `figure` in a link to `url`.
 *
 * Returns null when the figure cannot be wrapped cleanly: it spans a tag
 * boundary, or it is already inside a link. Neither is worth forcing.
 */
export function linkFigure(blockHtml: string, figure: string, url: string): string | null {
  const mapped = mapHtmlText(blockHtml);
  const at = locateText(mapped.text, figure);
  if (!at) return null;
  const range = htmlRange(mapped, at.start, at.end);
  if (!range) return null;
  if (insideAnchor(blockHtml, range.start)) return null;
  return (
    blockHtml.slice(0, range.start) +
    `<a href="${escapeAttr(url)}" rel="nofollow noopener" target="_blank">` +
    blockHtml.slice(range.start, range.end) +
    "</a>" +
    blockHtml.slice(range.end)
  );
}

// ── The pass ───────────────────────────────────────────────────────────────

function bareClaims(report: FactCheckReport): ExtractedClaim[] {
  return report.claims.filter((c) => c.status === "unsourced" && c.severity === "high");
}

/** Figures in this block that no longer have to be there. */
function figuresOf(claims: ExtractedClaim[]): string[] {
  return [...new Set(claims.flatMap((c) => c.figures))];
}

/** A sentence the checker truncated at 400 characters cannot be located whole. */
function isTruncated(sentence: string): boolean {
  return sentence.endsWith("...") && sentence.length >= 400;
}

function textOf(html: string): string {
  return mapHtmlText(html).text.replace(/\s+/g, " ").trim();
}

/**
 * Fix every bare figure in one block, cheapest honest move first.
 *
 * Returns the block unchanged when there was nothing to fix.
 */
async function fixBlock(
  blockHtml: string,
  opts: SourcingOptions,
  verified: Map<string, boolean>,
  tally: { sourced: number; rewritten: number; cut: number },
): Promise<string> {
  let html = blockHtml;
  let claims = bareClaims(factCheckArticle(html, opts.research));
  if (claims.length === 0) return html;

  // 1. Source it.
  for (const figure of figuresOf(claims)) {
    const candidate = candidateSource(figure, opts.research);
    if (!candidate) continue;
    if (!verified.has(candidate.url)) {
      let ok = false;
      try {
        ok = opts.verifyUrl ? await opts.verifyUrl(candidate.url) : false;
      } catch {
        ok = false;
      }
      verified.set(candidate.url, ok);
    }
    if (!verified.get(candidate.url)) continue;
    const linked = linkFigure(html, figure, candidate.url);
    if (!linked) continue;
    html = linked;
    tally.sourced += 1;
  }

  claims = bareClaims(factCheckArticle(html, opts.research));
  if (claims.length === 0) return html;

  // 2. Rewrite it.
  if (opts.rewrite) {
    const figures = figuresOf(claims);
    let proposed: string | null = null;
    try {
      proposed = await opts.rewrite({ html, figures, language: opts.language });
    } catch {
      proposed = null;
    }
    if (proposed && acceptableRewrite(html, proposed, figures, opts)) {
      html = proposed;
      tally.rewritten += 1;
      claims = bareClaims(factCheckArticle(html, opts.research));
      if (claims.length === 0) return html;
    }
  }

  // 3. Cut it. Longest sentence first, so removing one does not move the
  //    offsets of another that is still to be found by its own text.
  for (const claim of [...claims].sort((a, b) => b.sentence.length - a.sentence.length)) {
    if (isTruncated(claim.sentence)) {
      // A sentence the checker had to truncate cannot be matched whole, and
      // guessing where it ends would cut into the one after it. The block goes.
      tally.cut += 1;
      return "";
    }
    const mapped = mapHtmlText(html);
    const at = locateText(mapped.text, claim.sentence);
    if (!at) continue;
    html = cutRange(html, mapped, at.start, at.end);
    tally.cut += 1;
  }

  // A block that is now punctuation and empty tags is not a paragraph.
  if (textOf(html).replace(/[^\p{L}\p{N}]/gu, "").length < 12) return "";
  return html;
}

/**
 * Is this rewrite worth taking?
 *
 * The model was asked to drop the figures; the only answer that counts is one
 * where they are actually gone. Everything else here guards against the two
 * ways a rewrite destroys an article: it comes back empty, or it comes back
 * without the links and images the original carried.
 */
export function acceptableRewrite(
  before: string,
  after: string,
  figures: string[],
  opts: Pick<SourcingOptions, "research"> = {},
): boolean {
  const body = after.trim();
  if (!body) return false;
  const text = textOf(body);
  if (text.length < 20) return false;
  if (text.length > textOf(before).length * 2) return false;
  // Every figure the checker flagged must be gone, and the rewrite must not
  // have brought new ones with it.
  if (bareClaims(factCheckArticle(body, opts.research)).length > 0) return false;
  for (const f of new Set(figures)) if (text.includes(f)) return false;
  const hrefs = (s: string) => [...s.matchAll(/<a\b[^>]*href=["']([^"']*)["']/gi)].map((m) => m[1]);
  const srcs = (s: string) => [...s.matchAll(/<img\b[^>]*src=["']([^"']*)["']/gi)].map((m) => m[1]);
  const afterHrefs = hrefs(body);
  const afterSrcs = srcs(body);
  if (!hrefs(before).every((h) => afterHrefs.includes(h))) return false;
  if (!srcs(before).every((s) => afterSrcs.includes(s))) return false;
  return true;
}

/**
 * Run the pass over a whole article.
 *
 * Idempotent by construction: a draft with nothing to fix comes back byte for
 * byte, having cost one fact check and no calls at all.
 */
export async function sourceUnsourcedFigures(
  html: string,
  opts: SourcingOptions = {},
): Promise<SourcingOutcome> {
  const first = factCheckArticle(html, opts.research);
  const tally = { sourced: 0, rewritten: 0, cut: 0 };
  if (bareClaims(first).length === 0) {
    return { html, report: first, ...tally };
  }

  const verified = new Map<string, boolean>();
  const blocks = topLevelBlocks(html);
  // Back to front: an edit to one block must not move the offsets of the next.
  let out = html;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    const fixed = await fixBlock(block.html, opts, verified, tally);
    if (fixed === block.html) continue;
    out = out.slice(0, block.start) + fixed + out.slice(block.end);
  }

  // Anything the block walk could not reach - a figure written straight into a
  // `<div>`, or a sentence the checker splits differently once its neighbours
  // are gone - is cut at document level. The pass has one job and it is not
  // allowed to finish without doing it.
  let report = factCheckArticle(out, opts.research);
  for (const claim of bareClaims(report)) {
    if (isTruncated(claim.sentence)) continue;
    const mapped = mapHtmlText(out);
    const at = locateText(mapped.text, claim.sentence);
    if (!at) continue;
    out = cutRange(out, mapped, at.start, at.end);
    tally.cut += 1;
  }
  report = factCheckArticle(out, opts.research);

  return { html: out, report, ...tally };
}

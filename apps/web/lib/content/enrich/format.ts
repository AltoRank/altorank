// ---------------------------------------------------------------------------
// Step 1: the article-format rules
// ---------------------------------------------------------------------------
//
// These are the rules the audit tab already checks a draft against, applied
// where they can be applied mechanically and only reported where they cannot.
// The line is deliberate: adding an id to a heading changes no meaning, while
// rewriting an opening sentence to "answer directly" would be the model's job
// and a post-processor's guess. So ids, rel attributes, alt text and a bare URL
// replaced by its page title are done here; a section that does not open with
// an answer is reported and left alone.

import { fetchSite } from "@/lib/audit/lenient-fetch";
import { classifyHref } from "@/lib/seo/links";
import {
  attrOf,
  setAttr,
  slugify,
  uniqueId,
  splitSections,
  firstParagraph,
  splitSentencesHtml,
  stripTags,
  firstSentence,
  decode,
  escapeHtml,
} from "./html";

export interface FormatFindings {
  /** Headings that received an id in this pass (existing ids are kept). */
  headingIds: number;
  /** H2s whose first sentence does not read as a direct answer. Reported, not rewritten. */
  directAnswerMissing: string[];
  /** Sentences bolded because they state a number and name its source. */
  claimsBolded: number;
  /** External links that received `rel="noopener"`. */
  externalLinks: number;
  /** Bare-URL anchors replaced with the page's title. */
  titledLinks: number;
  /** Images that had no alt text and received one from their context. */
  altAdded: number;
  /** YouTube embeds moved to the privacy-enhanced host. */
  videoPrivacyUpgraded: number;
}

export interface FormatOptions {
  /** The site's own domain: links to it are internal and get no `rel`. */
  siteDomain?: string | null;
  /** Fetches a page title for a bare-URL anchor. Injected so tests never hit the network. */
  fetchTitle?: (url: string) => Promise<string | null>;
  /** Upper bound on title fetches per article. */
  maxTitleFetches?: number;
}

const TITLE_FETCH_TIMEOUT_MS = 4_000;

/**
 * Give every H2 and H3 a stable id.
 *
 * Exported because the table of contents needs the same ids and must not
 * invent its own: two slugifiers drifting apart would produce a TOC whose
 * anchors point at nothing.
 */
export function ensureHeadingIds(html: string): { html: string; added: number } {
  const used = new Set<string>();
  for (const m of html.matchAll(/<h[23]\b[^>]*\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    used.add(m[1] ?? m[2]);
  }
  let added = 0;
  const out = html.replace(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi, (whole, level, attrs, inner) => {
    if (/\sid\s*=/i.test(attrs)) return whole;
    const id = uniqueId(slugify(inner), used);
    added++;
    return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, added };
}

/**
 * Openers that announce a section instead of answering it. A first sentence
 * that starts this way is the classic "in this section we will look at"
 * throat-clearing an answer engine skips past.
 */
const ANNOUNCEMENT_OPENERS =
  /^(in this (section|part|article|guide|post)|let'?s|before (we|you|diving)|now that|when it comes to|in today'?s|there are (many|several|a number of)|it'?s (important|worth|no secret)|as (we|you) (mentioned|saw|know)|first,? let|welcome)/i;

/**
 * Whether a section's first sentence reads as a direct answer to its heading.
 *
 * Direct means: present, short enough to be quoted whole, and not an
 * announcement of what the section is about to do. It does not check that
 * the sentence is *correct*; nothing here can.
 */
export function opensWithDirectAnswer(body: string): boolean {
  const first = firstParagraph(body);
  if (!first) return false;
  const text = stripTags(first.inner);
  if (!text) return false;
  const sentence = firstSentence(text);
  const words = sentence.split(/\s+/).filter(Boolean).length;
  if (words < 4 || words > 45) return false;
  if (ANNOUNCEMENT_OPENERS.test(sentence)) return false;
  // A question is not an answer.
  if (sentence.endsWith("?")) return false;
  return true;
}

/**
 * A sentence that states a figure and names where it came from. This is the
 * one sentence per section worth bolding: it is what a reader scanning for
 * evidence stops on, and what an answer engine lifts with attribution.
 */
const CITABLE_CLAIM =
  /\d[\d.,]*\s?(%|percent|per cent|million|billion|k\b|x\b|€|\$|£|hours?|days?|weeks?|months?|years?)?[^.!?]*?\b(according to|per|reports?|reported|found that|survey(?:ed)? by|data from|study by|research by|estimates?)\b|\b(according to|per|reports?|reported|found that|survey(?:ed)? by|data from|study by|research by)\b[^.!?]*?\d/i;

export function boldCitableClaims(html: string): { html: string; bolded: number } {
  const split = splitSections(html);
  if (!split.sections.length) return { html, bolded: 0 };
  let bolded = 0;

  const sections = split.sections.map((s) => {
    let done = false;
    const body = s.body.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (whole, attrs, inner) => {
      if (done) return whole;
      // A paragraph the writer already emphasised is left as written.
      if (/<(strong|b)\b/i.test(inner)) return whole;
      const sentences = splitSentencesHtml(inner);
      const idx = sentences.findIndex((sentence) => {
        const text = stripTags(sentence);
        return CITABLE_CLAIM.test(text) && text.split(/\s+/).length <= 60;
      });
      if (idx === -1) return whole;
      const target = sentences[idx];
      const trailing = target.match(/\s+$/)?.[0] ?? "";
      sentences[idx] = `<strong>${target.slice(0, target.length - trailing.length)}</strong>${trailing}`;
      done = true;
      bolded++;
      return `<p${attrs}>${sentences.join("")}</p>`;
    });
    return { heading: s.heading, body };
  });

  return { html: split.intro + sections.map((s) => s.heading + s.body).join(""), bolded };
}

function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  return /^(https?:\/\/|www\.)\S+$/i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(t);
}

async function defaultFetchTitle(url: string): Promise<string | null> {
  const res = await fetchSite(url, {
    signal: AbortSignal.timeout(TITLE_FETCH_TIMEOUT_MS),
    timeoutMs: TITLE_FETCH_TIMEOUT_MS,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AltoRank/1.0; +https://altorank.co)" },
  });
  if (!res.ok) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html/i.test(type)) return null;
  const head = (await res.text()).slice(0, 200_000);
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m ? decode(stripTags(m[1])) : "";
  return title && title.length <= 160 ? title : null;
}

/**
 * `rel="noopener"` on every external link, and a title in place of a bare URL.
 *
 * Internal links are left exactly as the resolver wrote them; the Tiptap
 * converter decides their `rel` and `target` from the domain later.
 */
export async function formatExternalLinks(
  html: string,
  opts: FormatOptions,
): Promise<{ html: string; externalLinks: number; titledLinks: number }> {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  if (!anchors.length) return { html, externalLinks: 0, titledLinks: 0 };

  const fetchTitle = opts.fetchTitle ?? defaultFetchTitle;
  const maxFetches = opts.maxTitleFetches ?? 8;
  let fetches = 0;

  const rewrites = await Promise.all(
    anchors.map(async (m) => {
      const [whole, attrs, inner] = m;
      const href = attrOf(`<a${attrs}>`, "href");
      if (!href || classifyHref(href, opts.siteDomain) !== "external") return null;

      let openTag = `<a${attrs}>`;
      const rel = attrOf(openTag, "rel") ?? "";
      const tokens = new Set(rel.split(/\s+/).filter(Boolean));
      if (!tokens.has("noopener")) tokens.add("noopener");
      openTag = setAttr(openTag, "rel", [...tokens].join(" "));

      let text = inner;
      let titled = false;
      if (looksLikeUrl(stripTags(inner)) && fetches < maxFetches) {
        fetches++;
        try {
          const title = await fetchTitle(href);
          if (title) {
            text = escapeHtml(title);
            titled = true;
          }
        } catch {
          // Unreachable or slow: the URL stays as the anchor text, which is
          // what the writer produced and is not wrong, only less readable.
        }
      }
      return { whole, replacement: `${openTag}${text}</a>`, titled };
    }),
  );

  let out = html;
  let externalLinks = 0;
  let titledLinks = 0;
  for (const r of rewrites) {
    if (!r) continue;
    externalLinks++;
    if (r.titled) titledLinks++;
    out = out.replace(r.whole, r.replacement);
  }
  return { html: out, externalLinks, titledLinks };
}

/**
 * Alt text on every image, taken from the caption when there is one and the
 * owning section's heading when there is not. Neither invents what the image
 * shows: a caption is the writer's own description, and the heading names
 * the subject the image was placed beside.
 */
export function ensureAltText(html: string): { html: string; added: number } {
  let added = 0;
  const split = splitSections(html);
  const fix = (fragment: string, fallback: string): string =>
    fragment.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>|<img\b[^>]*>/gi, (block) => {
      const caption = block.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
      const context = caption ? stripTags(caption[1]) : fallback;
      return block.replace(/<img\b[^>]*>/gi, (img) => {
        const alt = attrOf(img, "alt");
        if (alt && alt.trim()) return img;
        if (!context) return img;
        added++;
        return setAttr(img, "alt", context);
      });
    });
  if (!split.sections.length) return { html: fix(html, ""), added };
  const intro = fix(split.intro, stripTags(split.intro.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ""));
  const sections = split.sections.map((s) => ({ heading: s.heading, body: fix(s.body, s.headingText) }));
  return { html: intro + sections.map((s) => s.heading + s.body).join(""), added };
}

/** Move `youtube.com/embed` iframes to the privacy-enhanced host. */
export function upgradeVideoPrivacy(html: string): { html: string; upgraded: number } {
  let upgraded = 0;
  const out = html.replace(
    /(<iframe\b[^>]*src=["'])https?:\/\/(?:www\.)?youtube\.com\/embed\//gi,
    (_, prefix) => {
      upgraded++;
      return `${prefix}https://www.youtube-nocookie.com/embed/`;
    },
  );
  return { html: out, upgraded };
}

export async function applyFormat(
  html: string,
  opts: FormatOptions = {},
): Promise<{ html: string; findings: FormatFindings }> {
  const ids = ensureHeadingIds(html);
  const claims = boldCitableClaims(ids.html);
  const links = await formatExternalLinks(claims.html, opts);
  const alts = ensureAltText(links.html);
  const video = upgradeVideoPrivacy(alts.html);

  const directAnswerMissing = splitSections(video.html)
    .sections.filter((s) => !opensWithDirectAnswer(s.body))
    .map((s) => s.headingText);

  return {
    html: video.html,
    findings: {
      headingIds: ids.added,
      directAnswerMissing,
      claimsBolded: claims.bolded,
      externalLinks: links.externalLinks,
      titledLinks: links.titledLinks,
      altAdded: alts.added,
      videoPrivacyUpgraded: video.upgraded,
    },
  };
}

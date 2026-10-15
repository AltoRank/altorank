// ---------------------------------------------------------------------------
// The one HTML sanitiser: every piece of article, rewrite or scraped HTML the
// product renders or publishes goes through here
// ---------------------------------------------------------------------------
//
// Article HTML reaches the page from places this product does not fully
// control: the model (steered by crawled pages), a customer's live page read
// for a rewrite, a reviewer's own edit, and the `content` column, which a
// member's client can write. So nothing is passed through. The input is
// parsed by a maintained sanitiser (sanitize-html) and written out fresh from
// the allowlists below: only the tags an article uses, only the attributes
// named for each, every URL checked against one scheme rule, every value and
// every text run escaped.
//
// Used by: the Improvements and editor rewrite reviews (render), the hunk
// save and push path, inline SVG figures (editor, model import, server-side
// content validation and the publish serialiser), and the URL checks of the
// publish serialiser (lib/cms/html.ts).
//
// Pure and isomorphic: the same code runs in the browser and on the server,
// so a check on the way in and a check on the way out cannot disagree.

import sanitize from "sanitize-html";

// ── URLs ────────────────────────────────────────────────────────────────────

/** Hosts an embedded player may come from: YouTube, preferably its privacy-enhanced host. */
export const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/embed\//i;

const NAMED_REFS: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", colon: ":", tab: "\t", newline: "\n",
  nbsp: "\u00a0", sol: "/", lpar: "(", rpar: ")", period: ".", comma: ",",
};

/** Character references a scheme could hide behind, decoded for the scheme check only. */
function decodeRefs(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_REFS[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Whether a URL only navigates to (or, for an image, only loads) a page.
 *
 * Links: http, https, mailto, tel, or a relative path / fragment.
 * Images: http, https, or a relative path. No `data:`, no `blob:`.
 *
 * Read the way a browser reads it - references decoded, control characters
 * and whitespace removed - before the scheme is checked.
 */
export function isSafeUrl(raw: unknown, kind: "link" | "image" = "link"): raw is string {
  if (typeof raw !== "string") return false;
  const probe = decodeRefs(raw).replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u2028\u2029\ufeff]/g, "").toLowerCase();
  if (!probe) return false;
  // A backslash is read as a slash by URL parsers: "\\evil" is "//evil".
  const normalised = probe.replace(/\\/g, "/");
  const colon = normalised.indexOf(":");
  const firstSep = normalised.search(/[/?#]/);
  const relative = colon === -1 || (firstSep !== -1 && firstSep < colon);
  if (relative) return true;
  const scheme = normalised.slice(0, colon);
  if (scheme === "http" || scheme === "https") return true;
  if (kind === "link" && (scheme === "mailto" || scheme === "tel")) return true;
  return false;
}

/** The URL when it is safe for its kind, otherwise null. Returned as given (trimmed). */
export function safeUrl(raw: unknown, kind: "link" | "image" = "link"): string | null {
  return isSafeUrl(raw, kind) ? raw.trim() : null;
}

export function isEmbedSrc(raw: unknown): raw is string {
  return typeof raw === "string" && EMBED_HOSTS.test(raw.trim()) && isSafeUrl(raw, "image");
}

// ── Allowlists ─────────────────────────────────────────────────────────────

/**
 * Classes an article's own markup uses (lib/content/enrich, the reader's
 * caret). Anything else is dropped: inside the dashboard a class is styling
 * the app defines, and arbitrary utility classes could lay content over it.
 */
const ARTICLE_CLASSES = [
  "infographic", "article-image", "video-embed", "video-embed-blocked", "toc", "cta",
  "article-dates", "article-reviewer", "article-disclaimer", "stream-caret",
];

const HTML_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "strong", "b", "em", "i", "u", "s",
  "del", "ins", "blockquote", "q", "cite", "code", "pre", "kbd", "sup", "sub", "small", "mark", "abbr",
  "time", "span", "br", "hr", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "colgroup", "col", "figure", "figcaption", "img", "dl", "dt", "dd", "div", "section", "nav", "aside",
  "header", "footer", "article", "iframe",
];

/** What the infographic step writes: shapes and text, no references, no scripting, no <style>. */
const SVG_TAGS = [
  "svg", "g", "rect", "line", "polyline", "polygon", "path", "circle", "ellipse", "text", "tspan",
  "title", "desc",
];

/** SVG attribute names in their canonical case (the HTML parser lower-cases them). */
const SVG_CAMEL = ["viewBox", "preserveAspectRatio", "textLength", "lengthAdjust"];
const SVG_CASE: Record<string, string> = Object.fromEntries(SVG_CAMEL.map((n) => [n.toLowerCase(), n]));

const SVG_PRESENTATION = [
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "opacity", "fill-opacity", "stroke-opacity", "font-size", "font-weight", "font-family",
  "text-anchor", "dominant-baseline", "transform",
];
const SVG_GEOMETRY = [
  "x", "y", "x1", "y1", "x2", "y2", "dx", "dy", "cx", "cy", "r", "rx", "ry", "width", "height",
  "points", "d", ...SVG_CAMEL,
];
const ARIA = ["role", "aria-label", "aria-hidden", "aria-labelledby", "aria-describedby", "id"];

const SVG_ATTRIBUTES: Record<string, string[]> = Object.fromEntries(
  SVG_TAGS.map((t) => [t, t === "title" || t === "desc" ? [] : [...SVG_GEOMETRY, ...SVG_PRESENTATION, ...ARIA]]),
);
SVG_ATTRIBUTES.svg = [...SVG_ATTRIBUTES.svg, "xmlns", "style", "focusable"];

const HEADING_ATTRS = ["id"];
const HTML_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  iframe: ["src", "title", "width", "height", "loading", "allow", "allowfullscreen", "referrerpolicy"],
  h1: HEADING_ATTRS, h2: HEADING_ATTRS, h3: HEADING_ATTRS, h4: HEADING_ATTRS, h5: HEADING_ATTRS, h6: HEADING_ATTRS,
  td: ["colspan", "rowspan"], th: ["colspan", "rowspan", "scope"],
  ol: ["start", "reversed"], col: ["span"], colgroup: ["span"],
  time: ["datetime"], abbr: ["title"], q: ["cite"], blockquote: ["cite"],
};

// ── Attribute values ───────────────────────────────────────────────────────

const PAINT = /^(#[0-9a-f]{3,8}|currentcolor|none|transparent|[a-z]{3,20}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\))$/i;
/** Numbers, lengths, lists of them, path data and keywords: no quotes, no colons, no parentheses. */
const PLAIN = /^[-+\w\s.,%#]*$/;
const TRANSFORM = /^[-+\w\s.,()]*$/;
const FONT_FAMILY = /^[-\w\s,]*$/;
const ID = /^[A-Za-z][\w:.-]{0,99}$/;
const SMALL_INT = /^\d{1,4}$/;

function keepValue(tag: string, name: string, value: string, svg: boolean): string | null {
  const v = value.trim();
  if (svg) {
    if (name === "xmlns") return v === "http://www.w3.org/2000/svg" ? v : null;
    if (name === "fill" || name === "stroke") return PAINT.test(v) ? v : null;
    if (name === "transform") return TRANSFORM.test(v) ? v : null;
    if (name === "font-family") return FONT_FAMILY.test(v) ? v : null;
    if (name === "role") return /^[a-z]{1,20}$/.test(v) ? v : null;
    if (name === "id") return ID.test(v) ? v : null;
    if (name.startsWith("aria-") || name === "style") return value;
    return PLAIN.test(v) ? v : null;
  }
  switch (name) {
    case "href":
      return isSafeUrl(value, "link") ? v : null;
    case "cite":
      return isSafeUrl(value, "link") && /^https?:/i.test(v) ? v : null;
    case "src":
      if (tag === "iframe") return isEmbedSrc(value) ? v : null;
      return isSafeUrl(value, "image") ? v : null;
    case "target":
      return v === "_blank" ? v : null;
    case "rel":
      return /^[a-z\s]{1,80}$/i.test(v) ? v : null;
    case "loading":
      return v === "lazy" || v === "eager" ? v : null;
    case "referrerpolicy":
      return /^[a-z-]{1,40}$/.test(v) ? v : null;
    case "allow":
      return /^[a-z\s;-]{0,200}$/.test(v) ? v : null;
    case "id":
      return ID.test(v) ? v : null;
    case "scope":
      return /^(row|col|rowgroup|colgroup)$/.test(v) ? v : null;
    case "width":
    case "height":
      return /^\d{1,5}%?$/.test(v) ? v : null;
    case "colspan":
    case "rowspan":
    case "start":
    case "span":
      return SMALL_INT.test(v) ? v : null;
    default:
      // alt, title, datetime, reversed, allowfullscreen: plain text, escaped on the way out.
      return value;
  }
}

const SVG_SET = new Set(SVG_TAGS);

/**
 * Every tag passes through here before the allowlists are applied: attribute
 * names are normalised (SVG's camelCase restored) and every value that is not
 * the right shape for its attribute is dropped.
 */
function filterAttributes(tagName: string, attribs: sanitize.Attributes): sanitize.Tag {
  const svg = SVG_SET.has(tagName);
  const out: sanitize.Attributes = {};
  for (const [rawName, value] of Object.entries(attribs)) {
    const lower = rawName.toLowerCase();
    const name = svg ? SVG_CASE[lower] ?? lower : lower;
    if (name in out) continue; // the first of a repeated attribute is the one a browser keeps
    if (name === "class") {
      out.class = value;
      continue;
    }
    const kept = keepValue(tagName, name, value, svg);
    if (kept !== null) out[name] = kept;
  }
  if (tagName === "a" && out.target === "_blank") {
    const rel = new Set((out.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean));
    rel.add("noopener");
    rel.add("noreferrer");
    out.rel = [...rel].join(" ");
  }
  return { tagName, attribs: out };
}

const SVG_STYLES = {
  svg: {
    "max-width": [/^\d{1,5}(\.\d+)?(px|%|em|rem)$/],
    "font-family": [/^[-\w\s,"']{1,100}$/],
  },
};

const BASE: sanitize.IOptions = {
  disallowedTagsMode: "discard",
  // What is dropped with everything inside it, not only the tag.
  nonTextTags: [
    "script", "style", "textarea", "option", "noscript", "template", "xmp", "noembed", "noframes",
    "plaintext", "select", "object", "embed", "applet", "math", "foreignobject", "head", "frameset",
  ],
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"], iframe: ["https"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  allowedStyles: SVG_STYLES,
  enforceHtmlBoundary: false,
  // The parser lower-cases tag and attribute names; filterAttributes restores
  // SVG's camelCase ones (viewBox) so a chart survives the round trip.
  parser: { lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true, decodeEntities: true },
  transformTags: { "*": filterAttributes },
  nestingLimit: 64,
};

const HTML_OPTIONS: sanitize.IOptions = {
  ...BASE,
  allowedTags: [...HTML_TAGS, ...SVG_TAGS],
  allowedAttributes: { ...SVG_ATTRIBUTES, ...HTML_ATTRIBUTES, "*": ["dir", "lang"] },
  allowedClasses: { "*": ARTICLE_CLASSES },
  // An iframe whose player is not YouTube is dropped with its contents.
  exclusiveFilter: (frame) => frame.tag === "iframe" && !isEmbedSrc(frame.attribs.src),
};

const SVG_OPTIONS: sanitize.IOptions = {
  ...BASE,
  allowedTags: SVG_TAGS,
  allowedAttributes: SVG_ATTRIBUTES,
  allowedClasses: {},
};

// ── Entry points ───────────────────────────────────────────────────────────

/**
 * Article, rewrite or scraped HTML, rebuilt from the allowlist. Safe to put
 * into a page as HTML, in the dashboard or on a customer's site.
 */
export function sanitizeHtml(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  return sanitize(html, HTML_OPTIONS);
}

/**
 * An inline SVG figure, rebuilt from the SVG allowlist, or null when what is
 * left is not exactly one <svg> element with something drawn in it (text or a
 * second root around it means the markup was not a figure; an empty one is
 * nothing to show).
 */
export function sanitizeSvg(svg: unknown): string | null {
  if (typeof svg !== "string") return null;
  const trimmed = svg.trim();
  if (!/^<svg\b/i.test(trimmed)) return null;
  const out = sanitize(trimmed, SVG_OPTIONS).trim();
  if (!/^<svg\b[^>]*>[\s\S]*<\/svg>$/.test(out)) return null;
  if ((out.match(/<svg\b/g) ?? []).length !== 1) return null;
  if (!/^<svg\b[^>]*>\s*<[a-z]/.test(out)) return null;
  return out;
}

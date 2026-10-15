// ---------------------------------------------------------------------------
// An article's HTML, rebuilt from an allowlist, for the gate's reader
// ---------------------------------------------------------------------------
//
// The gate's reader (components/onboarding/first-article-reader.tsx) puts
// this into the page as HTML, on the app's own origin, in the owner's
// session. What it is given is not only this product's writer: the writer is
// steered by crawled pages, and `content` is a column a member's own client
// can write. The first version stripped what it knew to be dangerous with
// regular expressions, and four ordinary payloads walked through it
// (`<img/src=x/onerror=...>`, `<svg/onload=...>`, an unquoted
// `href=javascript:`, an entity-encoded scheme).
//
// So nothing is passed through. The input is read as tags and text; the
// output is written fresh: only the tags an article uses, only the attributes
// named below, every value escaped, every text run escaped, every tag closed.
// A tag this reader does not parse the way a browser would can only lose an
// attribute or turn into visible text - it cannot become markup. Pure.

/** Tags an article is made of. Anything else is dropped; its text is kept. */
const ALLOWED = new Set([
  "p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "strong", "b", "em", "i", "u", "s",
  "blockquote", "q", "cite", "code", "pre", "sup", "sub", "small", "mark", "span", "br", "hr",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "figure", "figcaption", "img",
  "dl", "dt", "dd",
]);
const VOID = new Set(["br", "hr", "img"]);
/**
 * Dropped with everything inside them: what runs, embeds or submits, what a
 * browser reads as raw text, and the writer's own scaffolding (its <h1> - the
 * title is shown above - and its meta description).
 */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "template",
  "noscript", "noembed", "noframes", "textarea", "title", "xmp", "plaintext", "select", "svg", "math",
  "head", "h1", "meta-description",
]);

/** A tag, attribute-aware: a `>` inside a quoted value does not end it. */
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)(?:>|$)|<[!?][^>]*(?:>|$)/g;
/** One attribute: a name, and a quoted or bare value. `/` separates like whitespace. */
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
/** A character reference as HTML spells one, anchored where it is tested. */
const ENTITY = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", colon: ":", tab: "\t", newline: "\n", nbsp: "\u00a0", sol: "/", lpar: "(", rpar: ")" };

/** Decode the references a scheme could hide behind. Unknown names are left as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text as HTML: `<` and `>` escaped, and every `&` that does not start a reference. */
function escapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === "&") out += ENTITY.test(s.slice(i, i + 40)) ? "&" : "&amp;";
    else out += ch;
  }
  return out;
}

/**
 * A link target that navigates to a page and nowhere else: http(s), mailto,
 * or a relative path; for an image, http(s) only. Read the way a browser
 * reads it - references decoded, control characters and whitespace dropped -
 * before the scheme is checked.
 */
export function safeUrl(raw: string, opts: { images?: boolean } = {}): string | null {
  const decoded = decodeEntities(raw).trim();
  const probe = decoded.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
  if (!probe) return null;
  if (/^https?:\/\//.test(probe)) return decoded;
  if (opts.images) return null;
  if (probe.startsWith("mailto:")) return decoded;
  // Relative: no scheme before the first path, query or fragment character.
  const colon = probe.indexOf(":");
  const firstSep = probe.search(/[/?#]/);
  if (colon === -1 || (firstSep !== -1 && firstSep < colon)) return decoded;
  return null;
}

function unquote(value: string): string {
  const q = value[0];
  return value.length >= 2 && (q === "\"" || q === "'") && value.endsWith(q) ? value.slice(1, -1) : value;
}

function attributesFor(tag: string, raw: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    // The first of a repeated attribute is the one a browser keeps.
    if (seen.has(name)) continue;
    seen.add(name);
    const value = unquote(m[2] ?? "");
    if (tag === "a" && name === "href") {
      const url = safeUrl(value);
      if (url) out.push(`href="${escapeAttr(url)}"`);
    } else if (tag === "img" && name === "src") {
      const url = safeUrl(value, { images: true });
      if (url) out.push(`src="${escapeAttr(url)}"`);
    } else if ((tag === "img" && name === "alt") || ((tag === "a" || tag === "img") && name === "title")) {
      out.push(`${name}="${escapeAttr(decodeEntities(value))}"`);
    } else if (((tag === "td" || tag === "th") && (name === "colspan" || name === "rowspan")) || (tag === "ol" && name === "start")) {
      if (/^\d{1,3}$/.test(value.trim())) out.push(`${name}="${value.trim()}"`);
    }
  }
  if (tag === "a" && out.some((a) => a.startsWith("href="))) out.push('rel="nofollow noopener noreferrer"');
  return out.length ? ` ${out.join(" ")}` : "";
}

/** Where the closing tag of `name` ends, from `from`, or -1 when it has not been written yet. */
function closeOf(input: string, lower: string, name: string, from: number): number {
  for (let at = lower.indexOf(`</${name}`, from); at !== -1; at = lower.indexOf(`</${name}`, at + 2)) {
    const after = lower[at + 2 + name.length];
    if (after === undefined) return -1;
    if (after === ">" || after === "/" || /\s/.test(after)) {
      const gt = input.indexOf(">", at);
      return gt === -1 ? -1 : gt + 1;
    }
  }
  return -1;
}

/**
 * The article as the reader may show it: rebuilt from ALLOWED, with the
 * writer's <h1>, its meta description, a code fence and its link
 * placeholders taken out.
 */
export function readableHtml(html: string): string {
  const input = html
    .replace(/^\s*```(?:html)?\s*/i, "")
    // A tag the writer is half-way through: shown once it is whole.
    .replace(/<[^>]*$/, "")
    // So is a link placeholder: "{{internal-li" would flash as raw text.
    .replace(/\{\{[^}]*\}?$/, "");
  const lower = input.toLowerCase();
  let out = "";
  const open: string[] = [];
  let last = 0;
  const text = (s: string) => {
    if (s) out += escapeText(s.replace(/\{\{\s*internal-link:\s*([^}]*)\}\}/gi, "$1"));
  };
  for (const m of input.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    // Inside what a dropped element held: already skipped.
    if (at < last) continue;
    text(input.slice(last, at));
    last = at + m[0].length;
    const name = m[2]?.toLowerCase();
    if (!name) continue; // a comment, a doctype, a processing instruction
    const closing = m[1] === "/";
    if (!closing && DROP_WITH_CONTENT.has(name)) {
      // To its own closing tag, or to the end while it is still being written.
      const end = closeOf(input, lower, name, last);
      last = end === -1 ? input.length : end;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      const depth = open.lastIndexOf(name);
      if (depth === -1) continue;
      while (open.length > depth) out += `</${open.pop()}>`;
      continue;
    }
    out += `<${name}${attributesFor(name, m[3] ?? "")}>`;
    if (!VOID.has(name)) open.push(name);
  }
  if (last < input.length) text(input.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return withoutContents(out.trim());
}

/**
 * The finished article's table of contents, taken out for the reader.
 *
 * Enrichment adds it after the body is written (lib/content/enrich/toc.ts),
 * so in the reader it arrived as a block inserted near the top the moment
 * the stream turned into the saved article, shifting everything under a
 * person mid-read - and the same headings were then on screen three times
 * (recorded 2026-10-12). It is a list of in-page links and nothing else,
 * with its short label before it; the article's own H2s are the contents.
 */
const CONTENTS = /(?:<(p|h[2-6])>(?:<(?:strong|b)>)?[^<]{1,40}(?:<\/(?:strong|b)>)?<\/\1>\s*)?<ul>(?:\s*<li>\s*(?:<p>)?\s*<a href="#[^"]*"[^>]*>[^<]*<\/a>\s*(?:<\/p>)?\s*<\/li>)+\s*<\/ul>/g;

export function withoutContents(html: string): string {
  return html.replace(CONTENTS, "").replace(/\n{3,}/g, "\n\n");
}

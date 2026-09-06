import { classifyHref } from "@/lib/seo/links";

// ---------------------------------------------------------------------------
// HTML -> Tiptap ProseMirror JSON converter
//
// Converts a subset of HTML produced by the AI into the JSON structure
// that Tiptap / ProseMirror expects. We parse without a DOM library by
// walking a simple token stream -- keeps the server dependency-free.
// ---------------------------------------------------------------------------

type TiptapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
};

type TiptapDoc = {
  type: "doc";
  content: TiptapNode[];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TiptapOptions {
  /**
   * The site's own domain. A link to it is internal and is stored with no
   * `rel` and no `target`, so it opens in the same tab and passes authority.
   * Every link used to get `rel="noopener noreferrer nofollow"`, internal ones
   * included, which the editor then serialised on Copy as HTML: the site was
   * telling crawlers not to follow links to its own pages.
   */
  siteDomain?: string | null;
  /** Internal: SVG sources lifted out before tokenizing, by placeholder index. */
  svgs?: string[];
}

export function htmlToTiptapJson(html: string, opts: TiptapOptions = {}): TiptapDoc {
  // Inline SVG is kept as source, not walked: its elements are not prose and
  // the tokenizer would turn a chart's labels into a paragraph of numbers. Each
  // block is lifted out here and referenced by index from a placeholder tag.
  const svgs: string[] = [];
  const withPlaceholders = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
    svgs.push(svg);
    return `<svg-raw data-i="${svgs.length - 1}"></svg-raw>`;
  });
  const tokens = tokenize(withPlaceholders);
  const content = parseTokens(tokens, { ...opts, svgs });

  return {
    type: "doc",
    content: content.length > 0 ? content : [createParagraph([])],
  };
}

// ---------------------------------------------------------------------------
// Tokenizer -- splits HTML into open/close/self-closing tags and text runs
// ---------------------------------------------------------------------------

type Token =
  | { kind: "open"; tag: string; attrs: Record<string, string> }
  | { kind: "close"; tag: string }
  | { kind: "text"; value: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)\/?\s*>|([^<]+)/g;
  let m: RegExpExecArray | null;

  while ((m = tagPattern.exec(html)) !== null) {
    if (m[3] !== undefined) {
      // Text node
      const text = decodeEntities(m[3]);
      if (text) tokens.push({ kind: "text", value: text });
    } else {
      const raw = m[0];
      const tag = m[1].toLowerCase();
      if (raw.startsWith("</")) {
        tokens.push({ kind: "close", tag });
      } else {
        tokens.push({ kind: "open", tag, attrs: parseAttrs(m[2] || "") });
      }
    }
  }

  return tokens;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Parser -- converts token stream into Tiptap nodes
// ---------------------------------------------------------------------------

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_TAGS = new Set(["ul", "ol"]);
const TABLE_TAGS = ["table", "thead", "tbody", "tr", "th", "td"] as const;
/**
 * Containers with no node of their own: the enrichment writes a TOC as
 * `<nav>` and a call to action as `<section>`, and a model sometimes wraps
 * the whole body in `<article>` or `<div>`. Their children are parsed in place.
 */
const TRANSPARENT_TAGS = new Set(["nav", "section", "div", "article", "aside", "header", "footer", "main"]);
const BLOCK_TAGS = new Set([
  "p", "blockquote", "li", "hr", "br", "iframe", "figure", "img", "svg-raw", "figcaption",
  ...HEADING_TAGS, ...LIST_TAGS, ...TABLE_TAGS, ...TRANSPARENT_TAGS,
]);
const INLINE_MARK_MAP: Record<string, string> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  code: "code",
  s: "strike",
  strike: "strike",
  u: "underline",
};

function parseTokens(tokens: Token[], opts: TiptapOptions = {}): TiptapNode[] {
  const result: TiptapNode[] = [];
  let pos = 0;

  while (pos < tokens.length) {
    const token = tokens[pos];

    if (token.kind === "text") {
      // Orphan text -- wrap in paragraph
      const trimmed = token.value.trim();
      if (trimmed) {
        result.push(createParagraph([{ type: "text", text: trimmed }]));
      }
      pos++;
      continue;
    }

    if (token.kind === "close") {
      // Stray close tag -- skip
      pos++;
      continue;
    }

    // Open tag
    const { tag, attrs } = token;

    if (HEADING_TAGS.has(tag)) {
      const level = parseInt(tag[1], 10);
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, tag, opts);
      result.push({
        type: "heading",
        // The id is the anchor a table of contents links to and the jump link
        // a search result shows. Kept when present; the editor extension and
        // the serialiser both carry it through.
        attrs: attrs.id ? { level, id: attrs.id } : { level },
        content: inline.length > 0 ? inline : undefined,
      });
      pos = endPos;
      continue;
    }

    if (tag === "p") {
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, tag, opts);
      result.push(createParagraph(inline));
      pos = endPos;
      continue;
    }

    if (tag === "blockquote") {
      const { nodes: inner, endPos } = collectBlock(tokens, pos + 1, tag, opts);
      result.push({
        type: "blockquote",
        content: inner.length > 0 ? inner : [createParagraph([])],
      });
      pos = endPos;
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const { nodes: items, endPos } = collectListItems(tokens, pos + 1, tag, opts);
      const listType = tag === "ol" ? "orderedList" : "bulletList";
      result.push({
        type: listType,
        content: items.length > 0 ? items : undefined,
      });
      pos = endPos;
      continue;
    }

    if (tag === "table") {
      const { node, endPos } = collectTable(tokens, pos + 1, opts);
      if (node) result.push(node);
      pos = endPos;
      continue;
    }

    if (tag === "iframe") {
      result.push({
        type: "iframe",
        attrs: {
          src: attrs.src || "",
          width: attrs.width || "100%",
          height: attrs.height || "400",
          title: attrs.title || "",
          allowfullscreen: attrs.allowfullscreen !== undefined,
        },
      });
      // Skip to closing iframe tag if present
      let skip = pos + 1;
      while (skip < tokens.length) {
        const t = tokens[skip];
        if (t.kind === "close" && t.tag === "iframe") {
          skip++;
          break;
        }
        skip++;
      }
      pos = skip;
      continue;
    }

    if (tag === "figure") {
      // A figure is one node - image, video or chart - with its caption as an
      // attribute. Parsed as a block it used to unwrap to its children, and
      // since neither `img` nor `figcaption` had a node, an image figure
      // arrived in the editor as nothing at all.
      const { nodes: inner, endPos } = collectBlock(tokens, pos + 1, tag, opts);
      const caption = inner.find((n) => n.type === "figcaption");
      const captionText = caption ? inlineText(caption) : null;
      const media = inner.find((n) => n.type === "image" || n.type === "iframe" || n.type === "svgFigure");
      if (media) {
        if (captionText) media.attrs = { ...media.attrs, caption: captionText };
        result.push(media);
      } else {
        result.push(...inner.filter((n) => n.type !== "figcaption"));
      }
      pos = endPos;
      continue;
    }

    if (tag === "figcaption") {
      // Only meaningful inside a figure, where the figure branch above reads
      // it back. Carried as a transient node so it can be found there.
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, tag, opts);
      result.push({ type: "figcaption", content: inline });
      pos = endPos;
      continue;
    }

    if (tag === "img") {
      if (attrs.src) {
        result.push({
          type: "image",
          attrs: { src: attrs.src, alt: attrs.alt ?? "", title: attrs.title ?? null },
        });
      }
      pos++;
      // A non-void `<img></img>` from a sloppy writer.
      pos = skipClose(tokens, pos, "img");
      continue;
    }

    if (tag === "svg-raw") {
      const svg = opts.svgs?.[Number(attrs["data-i"])];
      if (svg) result.push({ type: "svgFigure", attrs: { svg } });
      pos++;
      pos = skipClose(tokens, pos, "svg-raw");
      continue;
    }

    if (TRANSPARENT_TAGS.has(tag)) {
      const { nodes: inner, endPos } = collectBlock(tokens, pos + 1, tag, opts);
      result.push(...inner);
      pos = endPos;
      continue;
    }

    if (tag === "hr") {
      result.push({ type: "horizontalRule" });
      pos++;
      continue;
    }

    if (tag === "br") {
      // top-level <br> -- skip
      pos++;
      continue;
    }

    // Unknown block or inline at top level -- try to parse as paragraph content
    if (!BLOCK_TAGS.has(tag)) {
      const { nodes: inline, endPos } = collectInline(tokens, pos, "", opts);
      if (inline.length > 0) {
        result.push(createParagraph(inline));
      }
      pos = endPos;
      continue;
    }

    pos++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Inline collector -- gathers text + marks until matching close tag
// ---------------------------------------------------------------------------

function collectInline(
  tokens: Token[],
  start: number,
  closeTag: string,
  opts: TiptapOptions = {},
): { nodes: TiptapNode[]; endPos: number } {
  const nodes: TiptapNode[] = [];
  let pos = start;
  const marks: TiptapMark[] = [];

  while (pos < tokens.length) {
    const token = tokens[pos];

    if (token.kind === "close" && token.tag === closeTag) {
      pos++; // consume close tag
      break;
    }

    if (token.kind === "text") {
      const textNode: TiptapNode = { type: "text", text: token.value };
      if (marks.length > 0) {
        textNode.marks = [...marks];
      }
      nodes.push(textNode);
      pos++;
      continue;
    }

    if (token.kind === "close") {
      // Closing an inline mark. `</a>` closes the link mark; without this the
      // link ran to the end of the paragraph, so "Visit <a>site</a>." stored
      // the full stop as a second link (seen in a generated CTA, 2026-09-04).
      const markType = token.tag === "a" ? "link" : INLINE_MARK_MAP[token.tag];
      if (markType) {
        const idx = marks.findLastIndex((m) => m.type === markType);
        if (idx !== -1) marks.splice(idx, 1);
      }
      pos++;
      continue;
    }

    // Open tag
    if (token.kind === "open") {
      const openTag = token.tag;
      const openAttrs = token.attrs;

      if (openTag === "br") {
        nodes.push({ type: "hardBreak" });
        pos++;
        continue;
      }

      // Link
      if (openTag === "a") {
        const href = openAttrs.href || "";
        marks.push({ type: "link", attrs: linkAttrs(href, opts) });
        pos++;
        continue;
      }

      // Inline marks
      const markType = INLINE_MARK_MAP[openTag];
      if (markType) {
        marks.push({ type: markType });
        pos++;
        continue;
      }

      // Block tag inside inline context -- stop collecting
      if (BLOCK_TAGS.has(openTag)) {
        break;
      }

      // Unknown inline tag -- skip the open tag, content will be collected
      pos++;
      continue;
    }

    pos++;
  }

  // If we ran out of tokens without finding the close tag, that's fine
  return { nodes, endPos: pos };
}

// ---------------------------------------------------------------------------
// Block collector -- for blockquote inner content
// ---------------------------------------------------------------------------

function collectBlock(
  tokens: Token[],
  start: number,
  closeTag: string,
  opts: TiptapOptions = {},
): { nodes: TiptapNode[]; endPos: number } {
  const innerTokens: Token[] = [];
  let pos = start;
  let depth = 0;

  while (pos < tokens.length) {
    const token = tokens[pos];
    if (token.kind === "open" && token.tag === closeTag) depth++;
    if (token.kind === "close" && token.tag === closeTag) {
      if (depth === 0) {
        pos++;
        break;
      }
      depth--;
    }
    innerTokens.push(token);
    pos++;
  }

  return { nodes: parseTokens(innerTokens, opts), endPos: pos };
}

// ---------------------------------------------------------------------------
// List item collector
// ---------------------------------------------------------------------------

function collectListItems(
  tokens: Token[],
  start: number,
  closeTag: string,
  opts: TiptapOptions = {},
): { nodes: TiptapNode[]; endPos: number } {
  const items: TiptapNode[] = [];
  let pos = start;

  while (pos < tokens.length) {
    const token = tokens[pos];

    if (token.kind === "close" && token.tag === closeTag) {
      pos++;
      break;
    }

    if (token.kind === "open" && token.tag === "li") {
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, "li", opts);
      // List items in Tiptap must contain a paragraph
      items.push({
        type: "listItem",
        content: [createParagraph(inline)],
      });
      pos = endPos;
      continue;
    }

    // Skip whitespace text between list items
    pos++;
  }

  return { nodes: items, endPos: pos };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attributes for a link mark, by where the link goes.
 *
 * Internal links (a relative path, or an absolute URL on the site's own
 * domain) get neither `rel` nor `target`: same tab, followed. Tiptap fills a
 * missing mark attribute with the Link extension's default, which is
 * `nofollow`, so the value has to be an explicit null rather than an omission.
 * External links keep `_blank` and the full rel: a citation opening in a new
 * tab is the convention, and nofollow on outbound links is unchanged here.
 */
function linkAttrs(href: string, opts: TiptapOptions): Record<string, unknown> {
  const kind = classifyHref(href, opts.siteDomain);
  if (kind === "internal" || kind === "anchor") {
    return { href, target: null, rel: null };
  }
  return { href, target: "_blank", rel: "noopener noreferrer nofollow" };
}

/** Step over a closing tag for `tag` when it is the next token. */
function skipClose(tokens: Token[], pos: number, tag: string): number {
  const next = tokens[pos];
  return next && next.kind === "close" && next.tag === tag ? pos + 1 : pos;
}

/** The plain text of a node's inline content, for a caption attribute. */
function inlineText(node: TiptapNode): string {
  return (node.content ?? [])
    .map((n) => (n.type === "text" ? n.text ?? "" : n.type === "hardBreak" ? " " : inlineText(n)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function createParagraph(content: TiptapNode[]): TiptapNode {
  return {
    type: "paragraph",
    content: content.length > 0 ? content : undefined,
  };
}


/**
 * Collect a `<table>` into Tiptap's table nodes.
 *
 * Comparison tables are exactly what "best X for Y" content is made of, and
 * without this every cell collapsed into one paragraph of adjacent text nodes:
 * a pricing table published as "Pricing modelHow it worksBest fitMonthly
 * retainerFixed scope...". It survived unnoticed because the damage happens at
 * HTML -> Tiptap, and publishing serialises back out of Tiptap, so the broken
 * version is what shipped.
 *
 * `thead` and `tbody` are walked through rather than represented: Tiptap has no
 * node for either, a header cell is just `tableHeader`.
 */
function collectTable(
  tokens: Token[],
  start: number,
  opts: TiptapOptions = {},
): { node: TiptapNode | null; endPos: number } {
  const rows: TiptapNode[] = [];
  let cells: TiptapNode[] = [];
  let pos = start;

  while (pos < tokens.length) {
    const token = tokens[pos];

    if (token.kind === "close" && token.tag === "table") {
      pos++;
      break;
    }

    if (token.kind === "open" && (token.tag === "th" || token.tag === "td")) {
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, token.tag, opts);
      cells.push({
        type: token.tag === "th" ? "tableHeader" : "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        // A cell, like a list item, must wrap its content in a block node.
        content: [createParagraph(inline)],
      });
      pos = endPos;
      continue;
    }

    if (token.kind === "close" && token.tag === "tr") {
      if (cells.length) rows.push({ type: "tableRow", content: cells });
      cells = [];
      pos++;
      continue;
    }

    pos++;
  }

  // A trailing row whose </tr> the model forgot to close.
  if (cells.length) rows.push({ type: "tableRow", content: cells });

  return {
    node: rows.length ? { type: "table", content: rows } : null,
    endPos: pos,
  };
}

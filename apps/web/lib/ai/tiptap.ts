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

export function htmlToTiptapJson(html: string): TiptapDoc {
  const tokens = tokenize(html);
  const content = parseTokens(tokens);

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
const BLOCK_TAGS = new Set([
  "p", "blockquote", "li", "hr", "br", "iframe", "figure",
  ...HEADING_TAGS, ...LIST_TAGS, ...TABLE_TAGS,
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

function parseTokens(tokens: Token[]): TiptapNode[] {
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
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, tag);
      result.push({
        type: "heading",
        attrs: { level },
        content: inline.length > 0 ? inline : undefined,
      });
      pos = endPos;
      continue;
    }

    if (tag === "p") {
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, tag);
      result.push(createParagraph(inline));
      pos = endPos;
      continue;
    }

    if (tag === "blockquote") {
      const { nodes: inner, endPos } = collectBlock(tokens, pos + 1, tag);
      result.push({
        type: "blockquote",
        content: inner.length > 0 ? inner : [createParagraph([])],
      });
      pos = endPos;
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const { nodes: items, endPos } = collectListItems(tokens, pos + 1, tag);
      const listType = tag === "ol" ? "orderedList" : "bulletList";
      result.push({
        type: listType,
        content: items.length > 0 ? items : undefined,
      });
      pos = endPos;
      continue;
    }

    if (tag === "table") {
      const { node, endPos } = collectTable(tokens, pos + 1);
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
      // Parse figure contents (may contain iframe or img)
      const { nodes: inner, endPos } = collectBlock(tokens, pos + 1, tag);
      if (inner.length > 0) {
        result.push(...inner);
      }
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
      const { nodes: inline, endPos } = collectInline(tokens, pos, "");
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
  closeTag: string
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
      // Closing an inline mark
      const markType = INLINE_MARK_MAP[token.tag];
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
        const linkMark: TiptapMark = {
          type: "link",
          attrs: {
            href,
            target: openAttrs.target || "_blank",
            rel: "noopener noreferrer nofollow",
          },
        };
        marks.push(linkMark);
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
  closeTag: string
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

  return { nodes: parseTokens(innerTokens), endPos: pos };
}

// ---------------------------------------------------------------------------
// List item collector
// ---------------------------------------------------------------------------

function collectListItems(
  tokens: Token[],
  start: number,
  closeTag: string
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
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, "li");
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
      const { nodes: inline, endPos } = collectInline(tokens, pos + 1, token.tag);
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

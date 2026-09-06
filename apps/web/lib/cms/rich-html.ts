// ---------------------------------------------------------------------------
// The article body, as blocks, for adapters whose CMS is not HTML
// ---------------------------------------------------------------------------
//
// Most connectors take `article.html` straight (WordPress, Ghost, Shopify,
// Webflow). Two do not: Wix wants Ricos nodes and Notion wants block objects.
// Both used to guess at the body with a regex, and both lost content doing it -
// Wix sent an empty paragraph, Notion's `([^<]*)` dropped every paragraph that
// contained a tag, which after `resolveInternalLinks` is most of them.
//
// So the HTML is parsed once, here, into a small block model that says what a
// paragraph, heading, list item, quote, table cell and inline link are. The
// two converters (lib/cms/ricos.ts, lib/cms/notion-blocks.ts) map that model
// onto their vendor's shape, and this file is where the parsing is tested.
//
// The input is our own HTML: lib/cms/html.ts renders the editor's ProseMirror
// document, and lib/ai/* adds links and citations to it. It is well formed and
// tag-limited, which is why a hand-rolled scanner is enough and no HTML parser
// is a dependency. Anything unrecognised is reported as an `unsupported` block
// rather than silently swallowed, so a caller can count what it could not send.

/** Inline styling that survives the trip to a CMS that is not HTML. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  /** An absolute or root-relative href. Internal links arrive as these. */
  href?: string;
}

export interface RichTableCell {
  spans: InlineSpan[];
  header: boolean;
}

export type RichBlock =
  | { type: "paragraph"; spans: InlineSpan[] }
  | { type: "heading"; level: number; spans: InlineSpan[] }
  | { type: "quote"; spans: InlineSpan[] }
  | { type: "listItem"; ordered: boolean; depth: number; spans: InlineSpan[] }
  | { type: "code"; text: string }
  | { type: "divider" }
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "embed"; src: string; caption?: string }
  | { type: "table"; rows: RichTableCell[][] }
  /** A node the model has no shape for - an inline SVG figure, say. */
  | { type: "unsupported"; tag: string; caption?: string };

// --- entities ---------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ccedil: "ç",
  ntilde: "ñ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  szlig: "ß",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

// --- tokenizer --------------------------------------------------------------

type Token =
  | { kind: "text"; text: string }
  | { kind: "open"; name: string; attrs: Record<string, string> }
  | { kind: "close"; name: string };

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "source", "col"]);

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[m[1].toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Scan HTML into open/close/text tokens.
 *
 * The end of a tag is found by walking for `>` outside quotes, because
 * lib/cms/html.ts escapes quotes in attributes but not `>`: an alt text with a
 * `>` in it would otherwise cut a tag in half.
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const pushText = (text: string) => {
    if (text) tokens.push({ kind: "text", text });
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    let j = lt + 1;
    let quote: string | null = null;
    while (j < html.length) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    if (j >= html.length) {
      // An unterminated tag: the rest is text, not a silent truncation.
      pushText(html.slice(lt));
      break;
    }

    const inner = html.slice(lt + 1, j).replace(/\/$/, "");
    i = j + 1;
    const closing = inner.startsWith("/");
    const body = (closing ? inner.slice(1) : inner).replace(/^\s+/, "");
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(body);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (closing) {
      tokens.push({ kind: "close", name });
    } else {
      tokens.push({ kind: "open", name, attrs: parseAttrs(body.slice(nameMatch[1].length)) });
      if (VOID_TAGS.has(name)) tokens.push({ kind: "close", name });
    }
  }

  return tokens;
}

// --- walker -----------------------------------------------------------------

type Style = Omit<InlineSpan, "text">;

interface Pending {
  type: "paragraph" | "heading" | "quote" | "listItem" | "cell" | "caption";
  level?: number;
  ordered?: boolean;
  depth?: number;
  header?: boolean;
  spans: InlineSpan[];
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const INLINE_STYLE_TAGS: Record<string, keyof Style> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  u: "underline",
  s: "strike",
  strike: "strike",
  del: "strike",
  code: "code",
};
/** Tags whose whole subtree is thrown away rather than flattened to text. */
const DROPPED_SUBTREES = new Set(["script", "style", "svg", "noscript", "head"]);

function styleOf(stack: Style[]): Style {
  const style: Style = {};
  for (const s of stack) Object.assign(style, s);
  return style;
}

function pushSpan(pending: Pending | null, text: string, style: Style): void {
  if (!pending || !text) return;
  const last = pending.spans[pending.spans.length - 1];
  const sameStyle =
    last &&
    !!last.bold === !!style.bold &&
    !!last.italic === !!style.italic &&
    !!last.underline === !!style.underline &&
    !!last.strike === !!style.strike &&
    !!last.code === !!style.code &&
    (last.href ?? "") === (style.href ?? "");
  if (sameStyle) {
    last.text += text;
    return;
  }
  pending.spans.push({ text, ...style });
}

/** Collapse HTML whitespace the way a browser would, without trimming words. */
function normaliseText(raw: string): string {
  return decodeEntities(raw).replace(/[ \t\r\n]+/g, " ");
}

export function trimSpans(spans: InlineSpan[]): InlineSpan[] {
  const out = spans.map((s) => ({ ...s })).filter((s) => s.text.length > 0);
  if (out.length === 0) return out;
  out[0].text = out[0].text.replace(/^[ \t\r\n]+/, "");
  out[out.length - 1].text = out[out.length - 1].text.replace(/[ \t\r\n]+$/, "");
  return out.filter((s) => s.text.length > 0);
}

export function spansToPlainText(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join("");
}

/**
 * Parse an article body into blocks.
 *
 * Nothing is dropped on the way: a paragraph with a link keeps the link as a
 * span, a list keeps its items and their nesting depth, a table keeps its
 * cells. Figures whose content has no block equivalent (an inline SVG chart)
 * come back as `unsupported` so the caller can say how many it could not send.
 */
export function parseRichHtml(html: string): RichBlock[] {
  const tokens = tokenize(html ?? "");
  const blocks: RichBlock[] = [];
  const styles: Style[] = [];
  const listStack: ("ul" | "ol")[] = [];
  // Every <li> the walker is inside. lib/cms/html.ts renders a list item as
  // `<li><p>text</p></li>`, so a <p> opening inside one continues the item
  // rather than starting a paragraph - which is how lists used to arrive at
  // Notion as a flat run of paragraphs.
  const liStack: { ordered: boolean; depth: number }[] = [];
  let pending: Pending | null = null;
  let preDepth = 0;
  let preText = "";
  let dropDepth = 0;
  let droppedTag = "";
  let quoteDepth = 0;
  // Table state: rows accumulate until </table>.
  let table: { rows: RichTableCell[][] } | null = null;

  const flush = () => {
    if (!pending) return;
    const spans = trimSpans(pending.spans);
    const current = pending;
    pending = null;
    if (spans.length === 0) return;

    switch (current.type) {
      case "paragraph":
        blocks.push({ type: "paragraph", spans });
        return;
      case "heading":
        blocks.push({ type: "heading", level: current.level ?? 2, spans });
        return;
      case "quote":
        blocks.push({ type: "quote", spans });
        return;
      case "listItem":
        blocks.push({
          type: "listItem",
          ordered: current.ordered ?? false,
          depth: current.depth ?? 0,
          spans,
        });
        return;
      case "cell": {
        if (!table) return;
        if (table.rows.length === 0) table.rows.push([]);
        table.rows[table.rows.length - 1].push({ spans, header: current.header ?? false });
        return;
      }
      case "caption": {
        // A figcaption belongs to the figure's own block.
        const previous = blocks[blocks.length - 1];
        const caption = spansToPlainText(spans);
        if (
          previous &&
          (previous.type === "image" || previous.type === "embed" || previous.type === "unsupported")
        ) {
          previous.caption = caption;
        } else {
          blocks.push({ type: "paragraph", spans });
        }
        return;
      }
    }
  };

  const startBlock = (next: Pending) => {
    flush();
    pending = next;
  };

  for (const token of tokens) {
    if (dropDepth > 0) {
      if (token.kind === "open" && token.name === droppedTag) dropDepth++;
      else if (token.kind === "close" && token.name === droppedTag) dropDepth--;
      continue;
    }

    if (preDepth > 0) {
      if (token.kind === "text") {
        preText += decodeEntities(token.text);
        continue;
      }
      if (token.kind === "open" && token.name === "pre") {
        preDepth++;
        continue;
      }
      if (token.kind === "close" && token.name === "pre") {
        preDepth--;
        if (preDepth === 0) {
          const text = preText.replace(/^\n+/, "").replace(/\s+$/, "");
          if (text) blocks.push({ type: "code", text });
          preText = "";
        }
        continue;
      }
      if (token.kind === "open" && token.name === "br") preText += "\n";
      continue;
    }

    if (token.kind === "text") {
      const text = normaliseText(token.text);
      if (!text.trim() && !pending) continue;
      if (!pending) startBlock({ type: "paragraph", spans: [] });
      pushSpan(pending, text, styleOf(styles));
      continue;
    }

    if (token.kind === "open") {
      const { name, attrs } = token;

      if (DROPPED_SUBTREES.has(name)) {
        flush();
        dropDepth = 1;
        droppedTag = name;
        blocks.push({ type: "unsupported", tag: name });
        continue;
      }

      if (name === "pre") {
        flush();
        preDepth = 1;
        preText = "";
        continue;
      }

      if (INLINE_STYLE_TAGS[name]) {
        styles.push({ [INLINE_STYLE_TAGS[name]]: true } as Style);
        continue;
      }

      if (name === "a") {
        const href = (attrs.href ?? "").trim();
        styles.push(href ? { href } : {});
        continue;
      }

      if (name === "br") {
        if (pending) pushSpan(pending, "\n", styleOf(styles));
        continue;
      }

      if (name === "p") {
        const item = liStack[liStack.length - 1];
        if (item) startBlock({ type: "listItem", ordered: item.ordered, depth: item.depth, spans: [] });
        else startBlock({ type: quoteDepth > 0 ? "quote" : "paragraph", spans: [] });
        continue;
      }

      if (HEADINGS.has(name)) {
        startBlock({ type: "heading", level: Number(name[1]), spans: [] });
        continue;
      }

      if (name === "blockquote") {
        flush();
        quoteDepth++;
        startBlock({ type: "quote", spans: [] });
        continue;
      }

      if (name === "ul" || name === "ol") {
        flush();
        listStack.push(name);
        continue;
      }

      if (name === "li") {
        const list = listStack[listStack.length - 1];
        const item = { ordered: list === "ol", depth: Math.max(0, listStack.length - 1) };
        liStack.push(item);
        startBlock({ type: "listItem", ...item, spans: [] });
        continue;
      }

      if (name === "hr") {
        flush();
        blocks.push({ type: "divider" });
        continue;
      }

      if (name === "img") {
        flush();
        const src = (attrs.src ?? "").trim();
        if (src) blocks.push({ type: "image", src, alt: attrs.alt ?? "" });
        continue;
      }

      if (name === "iframe") {
        flush();
        const src = (attrs.src ?? "").trim();
        if (src) blocks.push({ type: "embed", src });
        continue;
      }

      if (name === "figcaption") {
        startBlock({ type: "caption", spans: [] });
        continue;
      }

      if (name === "table") {
        flush();
        table = { rows: [] };
        continue;
      }

      if (name === "tr") {
        flush();
        if (table) table.rows.push([]);
        continue;
      }

      if (name === "td" || name === "th") {
        startBlock({ type: "cell", header: name === "th", spans: [] });
        continue;
      }

      // Everything else (div, figure, span, section, main, article, tbody...)
      // is a container: its children decide the blocks.
      continue;
    }

    // token.kind === "close"
    const { name } = token;

    if (INLINE_STYLE_TAGS[name] || name === "a") {
      styles.pop();
      continue;
    }
    if (name === "p" || HEADINGS.has(name) || name === "figcaption") {
      flush();
      continue;
    }
    if (name === "li") {
      flush();
      liStack.pop();
      continue;
    }
    if (name === "blockquote") {
      flush();
      quoteDepth = Math.max(0, quoteDepth - 1);
      continue;
    }
    if (name === "ul" || name === "ol") {
      flush();
      listStack.pop();
      continue;
    }
    if (name === "td" || name === "th") {
      flush();
      continue;
    }
    if (name === "table") {
      flush();
      if (table) {
        const rows = table.rows.filter((r) => r.length > 0);
        if (rows.length > 0) blocks.push({ type: "table", rows });
      }
      table = null;
      continue;
    }
  }

  flush();
  if (preDepth > 0 && preText.trim()) blocks.push({ type: "code", text: preText.trim() });
  if (table) {
    const rows = table.rows.filter((r) => r.length > 0);
    if (rows.length > 0) blocks.push({ type: "table", rows });
  }

  return blocks;
}

/** Whether a parse produced anything a reader would see. */
export function hasReadableContent(blocks: RichBlock[]): boolean {
  return blocks.some((b) => {
    switch (b.type) {
      case "paragraph":
      case "heading":
      case "quote":
      case "listItem":
        return spansToPlainText(b.spans).trim().length > 0;
      case "code":
        return b.text.trim().length > 0;
      case "table":
        return b.rows.some((row) => row.some((cell) => spansToPlainText(cell.spans).trim().length > 0));
      case "image":
      case "embed":
        return true;
      default:
        return false;
    }
  });
}

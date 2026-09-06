// ---------------------------------------------------------------------------
// The article body as Notion blocks
// ---------------------------------------------------------------------------
//
// Notion pages are trees of block objects, and inline styling is an
// annotation on a rich-text run rather than a tag. The adapter used to build
// them with `/<(h[1-3]|p|li)(?:\s[^>]*)?>([^<]*)<\/\1>/gi`, whose `([^<]*)`
// cannot match a paragraph containing a tag: every paragraph with an internal
// link or an inline citation - most of a generated article - matched nothing
// and was dropped, under a successful "Published to Notion". List items
// became paragraphs, and `blocks.slice(0, 100)` cut the rest away silently.
//
// This converts the block model from lib/cms/rich-html.ts instead: links
// become link annotations, lists stay lists (with nesting as children), and
// nothing is truncated - the adapter appends the blocks past Notion's
// hundred-per-request cap in further calls.
//
// https://developers.notion.com/reference/block
// https://developers.notion.com/reference/request-limits#limits-for-property-values

import { parseRichHtml, type InlineSpan, type RichBlock } from "./rich-html";

export type NotionBlock = Record<string, unknown>;

/** Notion's own caps, in one place because the adapter pages against them. */
export const NOTION_MAX_TEXT = 2000;
export const NOTION_MAX_RICH_TEXT = 100;
export const NOTION_MAX_CHILDREN = 100;

/**
 * Notion rejects a link whose URL is not absolute, and it rejects the whole
 * page for it. Internal links resolve to absolute URLs
 * (lib/seo/link-resolver.ts reads them off published_url or the crawl), so
 * this only bites a hand-written relative href: the words are kept and the
 * link is dropped, which is what stripDeadLinks does elsewhere for the same
 * reason.
 */
function usableLink(href: string | undefined): string | null {
  if (!href) return null;
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function annotationsOf(span: InlineSpan): Record<string, boolean> | undefined {
  const annotations: Record<string, boolean> = {};
  if (span.bold) annotations.bold = true;
  if (span.italic) annotations.italic = true;
  if (span.underline) annotations.underline = true;
  if (span.strike) annotations.strikethrough = true;
  if (span.code) annotations.code = true;
  return Object.keys(annotations).length ? annotations : undefined;
}

/** Split a run at Notion's 2,000-character limit rather than losing the tail. */
function chunk(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export function richText(spans: InlineSpan[]): NotionBlock[] {
  const out: NotionBlock[] = [];
  for (const span of spans) {
    const link = usableLink(span.href);
    const annotations = annotationsOf(span);
    for (const content of chunk(span.text, NOTION_MAX_TEXT)) {
      if (!content) continue;
      out.push({
        type: "text",
        text: { content, ...(link ? { link: { url: link } } : {}) },
        ...(annotations ? { annotations } : {}),
      });
    }
  }
  // A hundred runs is Notion's cap per block. Past it the styling of the tail
  // is dropped, not the words: the remainder is merged into one plain run.
  if (out.length > NOTION_MAX_RICH_TEXT) {
    const kept = out.slice(0, NOTION_MAX_RICH_TEXT - 1);
    const rest = out
      .slice(NOTION_MAX_RICH_TEXT - 1)
      .map((r) => ((r.text as { content?: string }).content ?? ""))
      .join("");
    kept.push({ type: "text", text: { content: rest.slice(0, NOTION_MAX_TEXT) } });
    return kept;
  }
  return out;
}

function block(type: string, payload: NotionBlock): NotionBlock {
  return { object: "block", type, [type]: payload };
}

function headingType(level: number): "heading_1" | "heading_2" | "heading_3" {
  // Notion stops at three heading levels; an h4 becomes a heading_3 rather
  // than a paragraph, so the outline survives.
  if (level <= 1) return "heading_1";
  if (level === 2) return "heading_2";
  return "heading_3";
}

function listType(ordered: boolean): "numbered_list_item" | "bulleted_list_item" {
  return ordered ? "numbered_list_item" : "bulleted_list_item";
}

/**
 * Turn our block model into Notion blocks.
 *
 * A nested list item becomes a child of the item above it, which is how
 * Notion expresses indentation. Everything else is a sibling.
 */
export function blocksToNotionBlocks(blocks: RichBlock[]): NotionBlock[] {
  const out: NotionBlock[] = [];
  /** The list item each depth is currently appending children to. */
  const listPath: NotionBlock[] = [];

  const appendListItem = (item: Extract<RichBlock, { type: "listItem" }>) => {
    const type = listType(item.ordered);
    const node = block(type, { rich_text: richText(item.spans) });
    const depth = Math.min(item.depth, listPath.length);
    if (depth === 0) {
      out.push(node);
      listPath.length = 0;
      listPath.push(node);
      return;
    }
    const parent = listPath[depth - 1];
    const parentPayload = parent[parent.type as string] as { children?: NotionBlock[] };
    parentPayload.children = parentPayload.children ?? [];
    parentPayload.children.push(node);
    listPath.length = depth;
    listPath.push(node);
  };

  for (const b of blocks) {
    if (b.type !== "listItem") listPath.length = 0;

    switch (b.type) {
      case "paragraph":
        out.push(block("paragraph", { rich_text: richText(b.spans) }));
        break;
      case "heading":
        out.push(block(headingType(b.level), { rich_text: richText(b.spans) }));
        break;
      case "quote":
        out.push(block("quote", { rich_text: richText(b.spans) }));
        break;
      case "listItem":
        appendListItem(b);
        break;
      case "code":
        out.push(
          block("code", {
            rich_text: richText([{ text: b.text }]),
            language: "plain text",
          }),
        );
        break;
      case "divider":
        out.push(block("divider", {}));
        break;
      case "image":
        out.push(
          block("image", {
            type: "external",
            external: { url: b.src },
            ...(b.caption ? { caption: richText([{ text: b.caption }]) } : {}),
          }),
        );
        break;
      case "embed":
        out.push(block("embed", { url: b.src }));
        break;
      case "table": {
        const width = Math.max(...b.rows.map((r) => r.length));
        out.push(
          block("table", {
            table_width: width,
            has_column_header: b.rows[0]?.every((c) => c.header) ?? false,
            has_row_header: false,
            children: b.rows.map((row) => ({
              object: "block",
              type: "table_row",
              table_row: {
                cells: Array.from({ length: width }, (_, i) => richText(row[i]?.spans ?? [])),
              },
            })),
          }),
        );
        break;
      }
      // An inline SVG figure has no Notion equivalent; it is left out, and
      // rich-html.ts reported it as unsupported so this is a choice, not a
      // regex accident.
      default:
        break;
    }
  }

  return out;
}

export function htmlToNotionBlocks(html: string): NotionBlock[] {
  return blocksToNotionBlocks(parseRichHtml(html));
}

/** Notion takes a hundred children per request; the rest are appended. */
export function pageChildren(blocks: NotionBlock[]): {
  first: NotionBlock[];
  rest: NotionBlock[][];
} {
  const first = blocks.slice(0, NOTION_MAX_CHILDREN);
  const rest: NotionBlock[][] = [];
  for (let i = NOTION_MAX_CHILDREN; i < blocks.length; i += NOTION_MAX_CHILDREN) {
    rest.push(blocks.slice(i, i + NOTION_MAX_CHILDREN));
  }
  return { first, rest };
}

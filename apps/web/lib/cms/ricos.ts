// ---------------------------------------------------------------------------
// The article body as Wix Ricos nodes
// ---------------------------------------------------------------------------
//
// Wix Blog's draft-post API takes `richContent`, a Ricos document: a tree of
// typed nodes, where styling is a list of decorations on a TEXT node rather
// than a tag around it. The adapter used to send one hardcoded empty
// paragraph - the title arrived, the article did not, and the product said
// "Published to Wix" and marked the row live.
//
// So the body is converted for real, from the block model in
// lib/cms/rich-html.ts. What Ricos has, this sends: paragraphs, headings,
// bulleted and ordered lists, blockquotes, code blocks, dividers and inline
// bold / italic / underline / link decorations.
//
// Two deliberate omissions, both because sending them would be a guess:
//   - images. A Ricos IMAGE node wants a Wix Media Manager id, not a URL on
//     our CDN; there is no upload step in this connector, so an <img> is left
//     out rather than posted as a node Wix would reject or render broken.
//   - strikethrough. The Ricos decoration set has BOLD, ITALIC, UNDERLINE,
//     LINK, COLOR, FONT_SIZE and friends - no strikethrough - so struck text
//     arrives as plain text rather than not at all.
// A table is flattened to one paragraph per row, cells separated by " | ",
// because a Ricos TABLE's cell tree is not something to invent here.
//
// https://dev.wix.com/docs/rest/business-solutions/blog/draft-post/draft-post-object
// https://dev.wix.com/docs/sdk/backend-modules/ricos/ricos-document/introduction

import { parseRichHtml, hasReadableContent, type InlineSpan, type RichBlock } from "./rich-html";

export interface RicosNode {
  type: string;
  id: string;
  nodes: RicosNode[];
  [key: string]: unknown;
}

/**
 * Node ids only have to be unique inside the document; Ricos treats them as
 * opaque. A counter keeps them stable for a given body, which is what makes
 * the converter testable.
 */
function idGen(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

function decorations(span: InlineSpan): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (span.bold) out.push({ type: "BOLD", fontWeightValue: 700 });
  if (span.italic) out.push({ type: "ITALIC", italicData: true });
  if (span.underline) out.push({ type: "UNDERLINE", underlineData: true });
  if (span.href) {
    out.push({
      type: "LINK",
      linkData: {
        link: {
          url: span.href,
          target: span.href.startsWith("http") ? "BLANK" : "SELF",
        },
      },
    });
  }
  return out;
}

function textNodes(spans: InlineSpan[]): RicosNode[] {
  return spans
    .filter((s) => s.text.length > 0)
    .map((span) => ({
      type: "TEXT",
      id: "",
      nodes: [],
      textData: { text: span.text, decorations: decorations(span) },
    }));
}

function paragraph(spans: InlineSpan[], nextId: () => string): RicosNode {
  return {
    type: "PARAGRAPH",
    id: nextId(),
    nodes: textNodes(spans),
    paragraphData: {},
  };
}

function plainParagraph(text: string, nextId: () => string): RicosNode {
  return paragraph([{ text }], nextId);
}

/**
 * Turn our block model into Ricos nodes.
 *
 * Consecutive list items of the same kind are gathered into one
 * BULLETED_LIST / ORDERED_LIST, because Ricos models a list as a node with
 * LIST_ITEM children, each holding a paragraph.
 */
export function blocksToRicosNodes(blocks: RichBlock[]): RicosNode[] {
  const nextId = idGen();
  const nodes: RicosNode[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    switch (block.type) {
      case "paragraph":
        nodes.push(paragraph(block.spans, nextId));
        break;

      case "heading":
        nodes.push({
          type: "HEADING",
          id: nextId(),
          nodes: textNodes(block.spans),
          // Ricos headings are 1-6, the same range as HTML.
          headingData: { level: Math.min(6, Math.max(1, block.level)) },
        });
        break;

      case "quote":
        nodes.push({
          type: "BLOCKQUOTE",
          id: nextId(),
          nodes: [paragraph(block.spans, nextId)],
          blockquoteData: { indentation: 0 },
        });
        break;

      case "listItem": {
        // Take every following item of the same ordering as one list.
        const ordered = block.ordered;
        const items: RichBlock[] = [];
        while (i < blocks.length) {
          const next = blocks[i];
          if (next.type !== "listItem" || next.ordered !== ordered) break;
          items.push(next);
          i++;
        }
        i--;
        nodes.push({
          type: ordered ? "ORDERED_LIST" : "BULLETED_LIST",
          id: nextId(),
          nodes: items.map((item) => ({
            type: "LIST_ITEM",
            id: nextId(),
            nodes: [paragraph(item.type === "listItem" ? item.spans : [], nextId)],
          })),
          ...(ordered ? { orderedListData: {} } : { bulletedListData: {} }),
        });
        break;
      }

      case "code":
        nodes.push({
          type: "CODE_BLOCK",
          id: nextId(),
          nodes: textNodes([{ text: block.text }]),
          codeBlockData: {},
        });
        break;

      case "divider":
        nodes.push({
          type: "DIVIDER",
          id: nextId(),
          nodes: [],
          dividerData: { lineStyle: "SINGLE", width: "LARGE", alignment: "CENTER" },
        });
        break;

      case "table":
        for (const row of block.rows) {
          const text = row.map((cell) => cell.spans.map((s) => s.text).join("")).join(" | ");
          if (text.trim()) nodes.push(plainParagraph(text, nextId));
        }
        break;

      // image / embed / unsupported: see the note at the top of this file.
      default:
        break;
    }
  }

  return nodes;
}

/**
 * The article body as Ricos nodes, or a refusal.
 *
 * Throwing is the point. A body that converts to nothing used to be published
 * as an empty post under a "Published to Wix" toast, with the row marked live
 * and the URL handed to IndexNow; an error the person sees is the honest
 * outcome, because the article is still here and can be sent again.
 */
export function htmlToRicosNodes(html: string): RicosNode[] {
  const blocks = parseRichHtml(html);
  if (!hasReadableContent(blocks)) {
    throw new Error(
      "Wix refused: the article body converted to nothing, so publishing would have created an empty post. Nothing was sent.",
    );
  }
  const nodes = blocksToRicosNodes(blocks);
  if (nodes.length === 0) {
    throw new Error(
      "Wix refused: the article body has no text, list or heading this connector can send. Nothing was sent.",
    );
  }
  return nodes;
}

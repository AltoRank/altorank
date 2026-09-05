// ---------------------------------------------------------------------------
// Editor nodes for what the enrichment pipeline puts in an article
// ---------------------------------------------------------------------------
//
// Tiptap discards an entire document when its JSON contains a node type the
// schema does not know (`createNodeFromContent` catches the error and returns
// an empty doc). The generator stores `image`, `iframe` and `svgFigure` nodes
// and ids on headings, so without these the editor would open every enriched
// article blank. Each node is an atom: the reviewer can select, move or delete
// it, not edit inside it. The generated markup is the source of truth, and
// lib/cms/html.ts serialises the same attributes back out for publishing.
//
// `@tiptap/react` re-exports `@tiptap/core`, so nothing new is installed.

import { Node, Extension } from "@tiptap/react";
import { isSafeSvg } from "@/lib/content/enrich/svg";

/** Same allowlist as the serialiser. An iframe from anywhere else renders nothing. */
const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/embed\//i;

/**
 * `id` on headings. The table of contents links to it and search results use
 * it for jump links; without this attribute Tiptap dropped it on load and the
 * TOC pointed at nothing once the reviewer saved.
 */
export const HeadingIds = Extension.create({
  name: "headingIds",
  addGlobalAttributes() {
    return [
      {
        types: ["heading"],
        attributes: {
          id: {
            default: null,
            parseHTML: (element) => element.getAttribute("id"),
            renderHTML: (attributes) => (attributes.id ? { id: attributes.id } : {}),
          },
        },
      },
    ];
  },
});

function captionText(element: HTMLElement): string | null {
  const text = element.querySelector("figcaption")?.textContent?.trim();
  return text || null;
}

// The image node is shared with the editor's own image tools: one `image`
// node type, defined in lib/editor/image-node.ts (it carries the caption the
// pipeline writes). Two nodes with the same name would have Tiptap register
// only one of them, so it is re-exported here and left out of the array below;
// the editor adds it with its React node view attached.
export { ArticleImage } from "@/lib/editor/image-node";

export const VideoEmbed = Node.create({
  name: "iframe",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: "" },
      width: { default: "100%" },
      height: { default: "400" },
      allowfullscreen: { default: true },
      caption: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure",
        getAttrs: (element) => {
          const frame = (element as HTMLElement).querySelector("iframe");
          if (!frame) return false;
          return {
            src: frame.getAttribute("src"),
            title: frame.getAttribute("title") ?? "",
            caption: captionText(element as HTMLElement),
          };
        },
      },
      { tag: "iframe[src]" },
    ];
  },
  renderHTML({ node }) {
    const src = String(node.attrs.src ?? "");
    if (!EMBED_HOSTS.test(src)) {
      return ["figure", { class: "video-embed video-embed-blocked" }, ["figcaption", {}, "Embed removed: not a YouTube player."]];
    }
    const frame: [string, Record<string, unknown>] = [
      "iframe",
      {
        src,
        title: node.attrs.title ?? "",
        width: "100%",
        height: "400",
        loading: "lazy",
        allow: "accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
        referrerpolicy: "strict-origin-when-cross-origin",
        allowfullscreen: "true",
      },
    ];
    const caption = node.attrs.caption ? [["figcaption", {}, String(node.attrs.caption)]] : [];
    return ["figure", { class: "video-embed" }, frame, ...caption];
  },
});

export const InfographicFigure = Node.create({
  name: "svgFigure",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      svg: { default: null },
      caption: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "figure.infographic",
        getAttrs: (element) => {
          const svg = (element as HTMLElement).querySelector("svg")?.outerHTML ?? null;
          if (!isSafeSvg(svg)) return false;
          return { svg, caption: captionText(element as HTMLElement) };
        },
      },
    ];
  },
  renderHTML({ node }) {
    // A DOM node rather than an output spec, because the chart is source
    // markup and a spec has no way to carry markup. It is checked before it is
    // rendered, here and again on publish.
    const figure = document.createElement("figure");
    figure.className = "infographic";
    const svg = node.attrs.svg;
    if (isSafeSvg(svg)) figure.innerHTML = svg;
    if (node.attrs.caption) {
      const caption = document.createElement("figcaption");
      caption.textContent = String(node.attrs.caption);
      figure.appendChild(caption);
    }
    return figure;
  },
});

export const enrichmentNodes = [HeadingIds, VideoEmbed, InfographicFigure];

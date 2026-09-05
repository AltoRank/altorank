import { Node, mergeAttributes } from "@tiptap/react";

// ---------------------------------------------------------------------------
// An <img> the editor can hold
// ---------------------------------------------------------------------------
//
// StarterKit has no image node, so a document with a picture in its body lost
// it on the first save: Tiptap drops what its schema does not know. This is
// the smallest node that keeps `src`, `alt` and `title`, parses a bare <img>
// or one inside a <figure>, and renders back to the same <img>. The React node
// view that draws the per-image toolbar is attached by the editor, not here,
// so the node stays usable on the server.

export interface ImageAttrs {
  src: string;
  alt: string | null;
  title: string | null;
  /** A figcaption, when the enrichment pipeline wrote one (lib/content/enrich/images.ts). */
  caption: string | null;
}

function captionText(element: HTMLElement): string | null {
  const text = element.querySelector("figcaption")?.textContent?.trim();
  return text || null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleImage: {
      /** Insert an image at the selection. */
      setArticleImage: (attrs: Partial<ImageAttrs> & { src: string }) => ReturnType;
    };
  }
}

export const ArticleImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      caption: { default: null },
    };
  },

  // A bare <img>, or a <figure> holding one with its caption. The enrichment
  // pipeline writes the figure form and lib/cms/html.ts serialises it back;
  // one node for both means a stored document opens either way.
  parseHTML() {
    return [
      {
        tag: "figure",
        getAttrs: (element) => {
          const img = (element as HTMLElement).querySelector("img");
          if (!img) return false;
          return {
            src: img.getAttribute("src"),
            alt: img.getAttribute("alt"),
            title: img.getAttribute("title"),
            caption: captionText(element as HTMLElement),
          };
        },
      },
      { tag: "img[src]" },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { caption, ...rest } = HTMLAttributes;
    const img: [string, Record<string, unknown>] = ["img", mergeAttributes(rest)];
    if (!node.attrs.caption) return img;
    return ["figure", { class: "article-image" }, img, ["figcaption", {}, String(caption)]];
  },

  addCommands() {
    return {
      setArticleImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

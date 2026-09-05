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
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
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

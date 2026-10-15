/**
 * Convert Tiptap ProseMirror JSON to clean HTML for CMS publishing.
 */

import { headingLevel } from "@/lib/html/article-doc";
import { isEmbedSrc, safeUrl, sanitizeSvg } from "@/lib/html/sanitize";

// Every value that becomes markup or a URL here is held to lib/html/sanitize.ts,
// the same rules the editor and the server-side content check apply: a link
// keeps its href only when the scheme is one a page can navigate to
// (relative, #, http, https, mailto, tel), an image only an http(s) or
// relative src, an embed only a YouTube player, a heading only a level from 1
// to 6, and an inline SVG figure is rebuilt from the SVG allowlist. The editor
// blanks a disallowed href on screen, so publishing one would have shown the
// reviewer a different link from the one the site serves.

type TiptapNode = {
  type: string;
  content?: TiptapNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

function renderMarks(text: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): string {
  if (!marks || marks.length === 0) return escapeHtml(text);

  let result = escapeHtml(text);
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        result = `<strong>${result}</strong>`;
        break;
      case "italic":
        result = `<em>${result}</em>`;
        break;
      case "link": {
        // `target` and `rel` are decided once, in lib/ai/tiptap.ts: an
        // external citation opens in a new tab and is nofollowed, an internal
        // link (a relative path, or the site's own domain) carries neither.
        // This renderer used to emit `href` alone, so every published article
        // shipped its citations followed and same-tab, whatever the editor
        // showed. A relative path never gets them: the editor's Link
        // extension stamps its defaults on a hand-added link, and a
        // nofollowed link to the site's own page is worse than a bare one.
        const href = safeUrl(mark.attrs?.href, "link");
        // A link the rules refuse is published as its text alone.
        if (!href) break;
        const relative = !/^[a-z][a-z0-9+.-]*:/i.test(href);
        const attr = (name: "target" | "rel") => {
          const v = mark.attrs?.[name];
          return !relative && typeof v === "string" && v.trim() ? ` ${name}="${escapeAttr(v.trim())}"` : "";
        };
        result = `<a href="${escapeAttr(href)}"${attr("target")}${attr("rel")}>${result}</a>`;
        break;
      }
      case "code":
        result = `<code>${result}</code>`;
        break;
      case "underline":
        result = `<u>${result}</u>`;
        break;
      case "strike":
        result = `<s>${result}</s>`;
        break;
    }
  }
  return result;
}

function renderNode(node: TiptapNode): string {
  if (node.type === "text") {
    return renderMarks(node.text ?? "", node.marks);
  }

  const children = node.content?.map(renderNode).join("") ?? "";

  switch (node.type) {
    case "doc":
      return children;
    case "paragraph":
      return `<p>${children}</p>\n`;
    case "heading": {
      const level = headingLevel(node.attrs?.level);
      const id = node.attrs?.id ? ` id="${escapeAttr(String(node.attrs.id))}"` : "";
      return `<h${level}${id}>${children}</h${level}>\n`;
    }
    case "bulletList":
      return `<ul>\n${children}</ul>\n`;
    case "orderedList":
      return `<ol>\n${children}</ol>\n`;
    case "listItem":
      return `<li>${children}</li>\n`;
    case "blockquote":
      return `<blockquote>${children}</blockquote>\n`;
    case "codeBlock":
      return `<pre><code>${children}</code></pre>\n`;
    case "image": {
      const safeSrc = safeUrl(node.attrs?.src, "image");
      if (!safeSrc) return "";
      const src = escapeAttr(safeSrc);
      const alt = escapeAttr(String(node.attrs?.alt ?? ""));
      const title = node.attrs?.title ? ` title="${escapeAttr(String(node.attrs.title))}"` : "";
      const caption = captionOf(node);
      return caption
        ? `<figure class="article-image"><img src="${src}" alt="${alt}"${title} loading="lazy" /><figcaption>${caption}</figcaption></figure>\n`
        : `<img src="${src}" alt="${alt}"${title} />\n`;
    }
    case "iframe": {
      const src = String(node.attrs?.src ?? "").trim();
      if (!isEmbedSrc(src)) return "";
      const title = escapeAttr(String(node.attrs?.title ?? ""));
      const caption = captionOf(node);
      return (
        `<figure class="video-embed"><iframe src="${escapeAttr(src)}" title="${title}" loading="lazy" ` +
        `allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" ` +
        `referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>` +
        `${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>\n`
      );
    }
    case "svgFigure": {
      // Rebuilt from the SVG allowlist (lib/html/sanitize.ts), never emitted as stored.
      const svg = sanitizeSvg(node.attrs?.svg);
      if (!svg) return "";
      const caption = captionOf(node);
      return `<figure class="infographic">${svg}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>\n`;
    }
    case "table":
      return `<table>\n${children}</table>\n`;
    case "tableRow":
      return `<tr>${children}</tr>\n`;
    case "tableCell":
      return `<td>${children}</td>`;
    case "tableHeader":
      return `<th>${children}</th>`;
    case "horizontalRule":
      return `<hr />\n`;
    case "hardBreak":
      return `<br />`;
    default:
      return children;
  }
}

function captionOf(node: TiptapNode): string {
  const caption = node.attrs?.caption;
  return typeof caption === "string" && caption.trim() ? escapeHtml(caption.trim()) : "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A value inside a double-quoted attribute. `&` is left as written: stored
 * hrefs carry the model's `&amp;`, and escaping it again would break them.
 * The quote is what ends the value, and it is always escaped.
 */
function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function tiptapToHtml(content: Record<string, unknown>): string {
  return renderNode(content as TiptapNode).trim();
}

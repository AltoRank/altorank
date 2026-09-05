/**
 * Convert Tiptap ProseMirror JSON to clean HTML for CMS publishing.
 */

import { isSafeSvg } from "@/lib/content/enrich/svg";

/**
 * Hosts an embedded player may come from. Only YouTube, and preferably its
 * privacy-enhanced host; an iframe pointing anywhere else is not published.
 */
const EMBED_HOSTS = /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/embed\//i;

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
      case "link":
        result = `<a href="${escapeAttr(String(mark.attrs?.href ?? ""))}">${result}</a>`;
        break;
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
      const level = node.attrs?.level ?? 2;
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
      const src = escapeAttr(String(node.attrs?.src ?? ""));
      const alt = escapeAttr(String(node.attrs?.alt ?? ""));
      const title = node.attrs?.title ? ` title="${escapeAttr(String(node.attrs.title))}"` : "";
      const caption = captionOf(node);
      return caption
        ? `<figure class="article-image"><img src="${src}" alt="${alt}"${title} loading="lazy" /><figcaption>${caption}</figcaption></figure>\n`
        : `<img src="${src}" alt="${alt}"${title} />\n`;
    }
    case "iframe": {
      const src = String(node.attrs?.src ?? "");
      if (!EMBED_HOSTS.test(src)) return "";
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
      const svg = node.attrs?.svg;
      if (!isSafeSvg(typeof svg === "string" ? svg : null)) return "";
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

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function tiptapToHtml(content: Record<string, unknown>): string {
  return renderNode(content as TiptapNode).trim();
}

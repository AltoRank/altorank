// ---------------------------------------------------------------------------
// An article's editor JSON, checked against the same rules as its HTML
// ---------------------------------------------------------------------------
//
// The editor saves TipTap JSON, the model's HTML is imported as TipTap JSON,
// and lib/cms/html.ts serialises it back out for publishing. The places in
// that JSON that end up as markup or as a URL are few: a link's href, an
// image's src, an embed's src, an inline SVG figure and a heading's level and
// id. Each is held to lib/html/sanitize.ts here; the rest is text, which the
// serialiser escapes. What does not pass is dropped (a link loses its mark
// and keeps its text), never rewritten into something else.

import { isEmbedSrc, safeUrl, sanitizeSvg } from "./sanitize";

export type DocNode = {
  type: string;
  content?: DocNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};

const MAX_DEPTH = 64;
const HEADING_ID = /^[A-Za-z][\w:.-]{0,99}$/;

/** A heading level the serialiser can write: an integer from 1 to 6. */
export function headingLevel(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d$/.test(raw.trim()) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 2;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanMarks(marks: unknown): DocNode["marks"] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: NonNullable<DocNode["marks"]> = [];
  for (const m of marks) {
    if (!isRecord(m) || typeof m.type !== "string") continue;
    if (m.type === "link") {
      const attrs = isRecord(m.attrs) ? m.attrs : {};
      const href = safeUrl(attrs.href, "link");
      if (!href) continue; // the text stays; the link goes
      out.push({ type: "link", attrs: { ...attrs, href } });
      continue;
    }
    out.push(isRecord(m.attrs) ? { type: m.type, attrs: m.attrs } : { type: m.type });
  }
  return out.length ? out : undefined;
}

function cleanNode(raw: unknown, depth: number): DocNode | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  if (depth > MAX_DEPTH) return null;
  const node: DocNode = { type: raw.type };
  const attrs = isRecord(raw.attrs) ? { ...raw.attrs } : undefined;

  switch (raw.type) {
    case "text": {
      if (typeof raw.text !== "string") return null;
      node.text = raw.text;
      const marks = cleanMarks(raw.marks);
      if (marks) node.marks = marks;
      return node;
    }
    case "heading": {
      const a = attrs ?? {};
      a.level = headingLevel(a.level);
      if (a.id !== undefined && a.id !== null && !(typeof a.id === "string" && HEADING_ID.test(a.id))) delete a.id;
      node.attrs = a;
      break;
    }
    case "image": {
      const src = safeUrl(attrs?.src, "image");
      if (!src) return null;
      node.attrs = { ...attrs, src };
      break;
    }
    case "iframe": {
      if (!isEmbedSrc(attrs?.src)) return null;
      node.attrs = attrs;
      break;
    }
    case "svgFigure": {
      const svg = sanitizeSvg(attrs?.svg);
      if (!svg) return null;
      node.attrs = { ...attrs, svg };
      break;
    }
    default:
      if (attrs) node.attrs = attrs;
  }

  if (Array.isArray(raw.content)) {
    node.content = raw.content.map((c) => cleanNode(c, depth + 1)).filter((c): c is DocNode => c !== null);
  }
  const marks = cleanMarks(raw.marks);
  if (marks) node.marks = marks;
  return node;
}

/**
 * The document with every href, src, SVG figure and heading level held to the
 * sanitiser's rules. Throws when the value is not a document at all.
 */
export function sanitizeArticleDoc(doc: unknown): DocNode {
  if (!isRecord(doc) || doc.type !== "doc") throw new Error("Article content must be a document");
  return cleanNode(doc, 0) as DocNode;
}

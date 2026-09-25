// ---------------------------------------------------------------------------
// Link extractor: every <a href> in the raw HTML, classified
// ---------------------------------------------------------------------------
//
// Links added by JavaScript are not here, deliberately: this is the link
// graph a non-rendering crawler can follow.

import { z } from "zod";
import { defineTool } from "../types";
import { publicUrl } from "../url";
import { kv, table, text, type Block } from "../blocks";
import { ToolError } from "../errors";
import { FetchFailedError, UnsafeUrlError } from "../safe-fetch";
import { decode, findElements, findTags, headOf, parseAttributes, relTokens, stripComments, clip } from "../html";

export const MAX_ROWS = 500;

export type LinkKind = "internal" | "external" | "anchor" | "mailto" | "tel" | "javascript" | "other" | "invalid";

export interface ExtractedLink {
  href: string;
  url: string | null;
  anchor: string;
  kind: LinkKind;
  rel: string[];
  target: string | null;
}

/** Same site: same host, ignoring a leading www. */
function sameSite(a: URL, b: URL): boolean {
  return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");
}

function anchorText(inner: string): string {
  const textValue = decode(inner.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " "));
  if (textValue) return textValue;
  // An image link: its alt text is the anchor.
  const img = inner.match(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i);
  if (img) {
    const alt = parseAttributes(img[1]).alt?.trim();
    return alt ? `[image: ${alt}]` : "[image, no alt]";
  }
  return "";
}

export function extractLinks(html: string, pageUrl: string): ExtractedLink[] {
  const clean = stripComments(html);
  const baseHref = findTags(headOf(clean), "base")[0]?.attrs.href;
  let base: URL;
  try {
    base = new URL(baseHref ?? pageUrl, pageUrl);
  } catch {
    base = new URL(pageUrl);
  }
  const page = new URL(pageUrl);

  return findElements(clean, "a")
    .filter((a) => a.attrs.href !== undefined)
    .map<ExtractedLink>((a) => {
      const href = a.attrs.href.trim();
      const rel = relTokens(a.attrs.rel);
      const target = a.attrs.target ?? null;
      const anchor = clip(anchorText(a.inner) || a.attrs["aria-label"] || a.attrs.title || "", 200);
      const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      if (scheme === "mailto" || scheme === "tel" || scheme === "javascript") {
        return { href, url: null, anchor, kind: scheme, rel, target };
      }
      if (href.startsWith("#") || href === "") {
        return { href, url: null, anchor, kind: "anchor", rel, target };
      }
      let u: URL;
      try {
        u = new URL(href, base);
      } catch {
        return { href, url: null, anchor, kind: "invalid", rel, target };
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") return { href, url: u.toString(), anchor, kind: "other", rel, target };
      // A link to this same page plus a fragment is an in-page anchor.
      if (u.hash && u.origin + u.pathname + u.search === page.origin + page.pathname + page.search) {
        return { href, url: u.toString(), anchor, kind: "anchor", rel, target };
      }
      return { href, url: u.toString(), anchor, kind: sameSite(u, page) ? "internal" : "external", rel, target };
    });
}

export const linkExtractor = defineTool({
  slug: "link-extractor",
  kind: "fetch",
  input: z.object({ url: publicUrl }),
  perIpLimit: { limit: 30, windowMs: 60 * 60 * 1000 },
  estimateCents: 0,
  async run({ url }, ctx) {
    let res;
    try {
      res = await ctx.fetch(url, { signal: ctx.signal });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new ToolError("invalid_input", err.message);
      throw new ToolError("upstream", `Could not fetch ${url}: ${err instanceof FetchFailedError ? err.message : "the request failed"}.`);
    }
    if (res.status >= 400) throw new ToolError("upstream", `${res.url} answered HTTP ${res.status}, so there are no links to read.`);

    const links = extractLinks(res.body, res.url);
    const count = (k: LinkKind) => links.filter((l) => l.kind === k).length;
    const nofollow = links.filter((l) => l.rel.includes("nofollow")).length;
    const sponsored = links.filter((l) => l.rel.includes("sponsored")).length;
    const ugc = links.filter((l) => l.rel.includes("ugc")).length;
    const blank = links.filter((l) => l.target === "_blank");
    const unsafeBlank = blank.filter((l) => l.kind === "external" && !l.rel.includes("noopener") && !l.rel.includes("noreferrer")).length;
    const emptyAnchor = links.filter((l) => (l.kind === "internal" || l.kind === "external") && !l.anchor).length;
    const unique = new Set(links.map((l) => l.url ?? l.href)).size;
    const externalDomains = new Set(links.filter((l) => l.kind === "external" && l.url).map((l) => new URL(l.url!).hostname)).size;

    const blocks: Block[] = [
      kv(
        [
          { label: "Page", value: res.url, status: "info" },
          { label: "Links", value: `${links.length} (${unique} unique)`, status: "info" },
          { label: "Internal", value: String(count("internal")), status: "info" },
          { label: "External", value: `${count("external")} to ${externalDomains} domain${externalDomains === 1 ? "" : "s"}`, status: "info" },
          { label: "In-page anchors", value: String(count("anchor")), status: "info" },
          { label: "mailto / tel", value: `${count("mailto")} / ${count("tel")}`, status: "info" },
          { label: "rel=nofollow", value: String(nofollow), status: "info" },
          { label: "rel=sponsored / ugc", value: `${sponsored} / ${ugc}`, status: "info" },
          { label: "Opens a new tab", value: String(blank.length), status: "info" },
          { label: "No anchor text", value: String(emptyAnchor), status: emptyAnchor ? "warn" : "pass" },
          ...(count("javascript") ? [{ label: "javascript: links", value: `${count("javascript")}; crawlers cannot follow these`, status: "warn" as const }] : []),
          ...(count("invalid") ? [{ label: "Invalid hrefs", value: String(count("invalid")), status: "fail" as const }] : []),
          ...(unsafeBlank
            ? [{ label: "target=_blank without noopener", value: String(unsafeBlank), status: "info" as const }]
            : []),
        ],
        "Summary",
      ),
      table(
        ["URL", "Anchor text", "Type", "rel", "target"],
        links.slice(0, MAX_ROWS).map((l) => [l.url ?? l.href, l.anchor || null, l.kind, l.rel.join(" ") || null, l.target]),
        "Links",
      ),
    ];
    if (links.length > MAX_ROWS) blocks.push(text(`Showing the first ${MAX_ROWS} of ${links.length} links.`));
    if (res.truncated) blocks.push(text("The page is over the size limit; only links in the first part were read."));
    return blocks;
  },
});

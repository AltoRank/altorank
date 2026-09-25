// ---------------------------------------------------------------------------
// Website metadata checker: what the <head> tells search engines and apps
// ---------------------------------------------------------------------------
//
// One fetch, raw HTML, no JavaScript: the metadata a crawler that does not
// render sees. Length guidance is what result pages display, measured in
// characters (titles cut near 60, descriptions near 160), not a score.

import { z } from "zod";
import { defineTool } from "../types";
import { publicUrl } from "../url";
import { kv, list, table, type Block, type KvItem } from "../blocks";
import { ToolError } from "../errors";
import { FetchFailedError, UnsafeUrlError } from "../safe-fetch";
import { decode, findElements, findTags, headOf, metaMap, relTokens, stripComments, clip } from "../html";

export interface JsonLdReport {
  blocks: number;
  invalid: number;
  types: string[];
  errors: string[];
}

export function readJsonLd(html: string): JsonLdReport {
  const scripts = findElements(stripComments(html), "script").filter(
    (s) => (s.attrs.type ?? "").trim().toLowerCase() === "application/ld+json",
  );
  const types: string[] = [];
  const errors: string[] = [];
  let invalid = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    const t = rec["@type"];
    if (Array.isArray(t)) types.push(...t.map(String));
    else if (typeof t === "string") types.push(t);
    for (const v of Object.values(rec)) if (v && typeof v === "object") walk(v);
  };
  scripts.forEach((s, i) => {
    const raw = s.inner.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try {
      walk(JSON.parse(raw));
    } catch (err) {
      invalid++;
      errors.push(`JSON-LD block ${i + 1} is not valid JSON: ${(err as Error).message.slice(0, 120)}`);
    }
  });
  return { blocks: scripts.length, invalid, types: [...new Set(types)], errors };
}

function lengthItem(label: string, value: string | undefined, ideal: [number, number], hardMax: number): KvItem {
  if (value === undefined) return { label, value: "missing", status: "fail" };
  if (!value) return { label, value: "present but empty", status: "fail" };
  const n = [...value].length;
  const status = n > hardMax || n < ideal[0] / 2 ? "warn" : n >= ideal[0] && n <= ideal[1] ? "pass" : "info";
  const note = n > hardMax ? `, likely cut off in results (over ${hardMax})` : n < ideal[0] ? ", short" : "";
  return { label, value: `${clip(value, 200)} (${n} characters${note})`, status };
}

export interface MetadataReport {
  items: KvItem[];
  social: (string | null)[][];
  jsonLd: JsonLdReport;
  hreflang: (string | null)[][];
}

export function analyseMetadata(html: string, pageUrl: string, headers: Record<string, string>): MetadataReport {
  const clean = stripComments(html);
  const head = headOf(clean);
  const meta = metaMap(head);
  const links = findTags(head, "link");
  const items: KvItem[] = [];

  const titles = findElements(head, "title");
  items.push(lengthItem("Title", titles[0] ? decode(titles[0].inner) : undefined, [30, 60], 60));
  if (titles.length > 1) items.push({ label: "Title tags", value: `${titles.length} <title> tags; search engines use one`, status: "warn" });

  const descs = meta.get("description");
  items.push(lengthItem("Meta description", descs?.[0], [70, 160], 160));
  if (descs && descs.length > 1) items.push({ label: "Meta descriptions", value: `${descs.length} description tags`, status: "warn" });

  const canon = links.filter((l) => relTokens(l.attrs.rel).includes("canonical"));
  if (!canon.length) items.push({ label: "Canonical", value: "none", status: "warn" });
  else {
    const href = canon[0].attrs.href ?? "";
    let abs = href;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      /* shown as written */
    }
    const self = abs.replace(/#.*$/, "") === pageUrl.replace(/#.*$/, "");
    items.push({
      label: "Canonical",
      value: `${clip(abs, 200)}${self ? " (this page)" : " (points elsewhere)"}${canon.length > 1 ? `; ${canon.length} canonical tags` : ""}`,
      status: canon.length > 1 ? "fail" : self ? "pass" : "info",
    });
  }

  const robotsMeta = [...(meta.get("robots") ?? []), ...(meta.get("googlebot") ?? [])].join(", ");
  const xRobots = headers["x-robots-tag"] ?? "";
  const noindex = /noindex|none/i.test(`${robotsMeta} ${xRobots}`);
  items.push({
    label: "Robots meta",
    value: robotsMeta || "none (defaults to index, follow)",
    status: /noindex|none/i.test(robotsMeta) ? "fail" : robotsMeta ? "info" : "pass",
  });
  items.push({ label: "X-Robots-Tag header", value: xRobots || "none", status: /noindex|none/i.test(xRobots) ? "fail" : "pass" });
  if (noindex) items.push({ label: "Indexable", value: "no: the page asks not to be indexed", status: "fail" });

  const htmlTag = findTags(clean, "html")[0];
  const lang = htmlTag?.attrs.lang?.trim();
  items.push({ label: "Language (html lang)", value: lang || "missing", status: lang ? "pass" : "warn" });

  const viewport = meta.get("viewport")?.[0];
  items.push({
    label: "Viewport",
    value: viewport || "missing: the page will render as desktop on phones",
    status: viewport ? (/width=device-width/i.test(viewport) ? "pass" : "warn") : "fail",
  });

  const icons = links.filter((l) => relTokens(l.attrs.rel).some((t) => t === "icon" || t === "apple-touch-icon"));
  items.push({
    label: "Favicon",
    value: icons.length ? clip(icons.map((i) => i.attrs.href ?? "").join(", "), 200) : "no <link rel=icon>; browsers will try /favicon.ico",
    status: icons.length ? "pass" : "info",
  });

  const h1s = findElements(clean, "h1");
  items.push({
    label: "H1 headings",
    value: h1s.length ? `${h1s.length}: ${clip(h1s.map((h) => decode(h.inner.replace(/<[^>]+>/g, " "))).join(" | "), 200)}` : "none",
    status: h1s.length === 1 ? "pass" : h1s.length === 0 ? "fail" : "warn",
  });

  const charset = findTags(head, "meta").some((m) => m.attrs.charset !== undefined || /charset=/i.test(m.attrs.content ?? ""));
  items.push({ label: "Charset declared", value: charset ? "yes" : "no", status: charset ? "pass" : "info" });

  const hreflangLinks = links.filter((l) => relTokens(l.attrs.rel).includes("alternate") && l.attrs.hreflang);
  const hreflang = hreflangLinks.map((l) => [l.attrs.hreflang ?? null, l.attrs.href ?? null]);
  if (hreflangLinks.length) {
    const hasXDefault = hreflangLinks.some((l) => l.attrs.hreflang?.toLowerCase() === "x-default");
    items.push({ label: "hreflang", value: `${hreflangLinks.length} alternates${hasXDefault ? ", with x-default" : ", no x-default"}`, status: hasXDefault ? "pass" : "info" });
  } else {
    items.push({ label: "hreflang", value: "none (fine for a single-language site)", status: "info" });
  }

  const socialKeys = [
    "og:title", "og:description", "og:image", "og:url", "og:type", "og:site_name",
    "twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:site",
  ];
  const social = socialKeys.map((k) => [k, meta.get(k)?.[0] ? clip(meta.get(k)![0], 200) : null]);
  const ogCore = ["og:title", "og:description", "og:image"].filter((k) => meta.get(k)?.[0]);
  items.push({
    label: "Open Graph",
    value: ogCore.length === 3 ? "title, description and image set" : `${3 - ogCore.length} of og:title, og:description, og:image missing`,
    status: ogCore.length === 3 ? "pass" : ogCore.length ? "warn" : "fail",
  });
  const card = meta.get("twitter:card")?.[0];
  items.push({ label: "Twitter card", value: card || "none (X falls back to Open Graph)", status: card ? "pass" : "info" });

  const jsonLd = readJsonLd(clean);
  items.push({
    label: "Structured data (JSON-LD)",
    value: jsonLd.blocks
      ? `${jsonLd.blocks} block${jsonLd.blocks === 1 ? "" : "s"}${jsonLd.types.length ? `: ${clip(jsonLd.types.join(", "), 200)}` : ""}${jsonLd.invalid ? `; ${jsonLd.invalid} invalid` : ""}`
      : "none",
    status: jsonLd.invalid ? "fail" : jsonLd.blocks ? "pass" : "warn",
  });

  return { items, social, jsonLd, hreflang };
}

export const websiteMetadataChecker = defineTool({
  slug: "website-metadata-checker",
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
    const report = analyseMetadata(res.body, res.url, res.headers);
    const fetchItems: KvItem[] = [
      { label: "Fetched", value: res.url, status: "info" },
      { label: "HTTP status", value: String(res.status), status: res.status >= 400 ? "fail" : res.redirects.length ? "info" : "pass" },
    ];
    if (res.redirects.length) fetchItems.push({ label: "Redirects", value: `${res.redirects.length} before the page`, status: "info" });
    const ct = res.headers["content-type"] ?? "";
    if (ct && !/html/i.test(ct)) fetchItems.push({ label: "Content-Type", value: `${ct}: not an HTML page`, status: "warn" });
    if (res.truncated) fetchItems.push({ label: "Size", value: "the page is over the size limit; only the start was read", status: "warn" });

    const blocks: Block[] = [kv([...fetchItems, ...report.items], "Metadata"), table(["Tag", "Content"], report.social, "Open Graph and Twitter")];
    if (report.hreflang.length) blocks.push(table(["hreflang", "URL"], report.hreflang.slice(0, 100), "Language alternates"));
    if (report.jsonLd.types.length) blocks.push(list(report.jsonLd.types, "Schema types found"));
    if (report.jsonLd.errors.length) blocks.push(list(report.jsonLd.errors, "JSON-LD errors"));
    return blocks;
  },
});

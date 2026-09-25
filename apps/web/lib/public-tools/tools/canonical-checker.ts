// ---------------------------------------------------------------------------
// Canonical checker: which URL does this page say is the real one, and does
// that URL hold up
// ---------------------------------------------------------------------------
//
// A canonical is a hint, and search engines drop hints that contradict
// themselves. So besides reading it, this checks what makes one ignored: more
// than one, HTML and HTTP header disagreeing, a tag in <body>, a target that
// redirects, errors, is noindex or names a different canonical of its own.

import { z } from "zod";
import { defineTool, type ToolContext } from "../types";
import { publicUrl } from "../url";
import { kv, list, table, type Block, type KvItem } from "../blocks";
import { ToolError } from "../errors";
import { FetchFailedError, UnsafeUrlError, type SafeFetchResult } from "../safe-fetch";
import { findTags, headOf, metaMap, relTokens, stripComments } from "../html";

export interface CanonicalSource {
  source: "html" | "header";
  href: string;
  absolute: string | null;
  inHead: boolean;
}

/** `<https://x/>; rel="canonical"` entries from a Link header. */
export function canonicalsFromLinkHeader(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const m of header.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]*)*)/g)) {
    const params = m[2];
    const rel = params.match(/;\s*rel\s*=\s*"?([^";]+)"?/i)?.[1] ?? "";
    if (relTokens(rel).includes("canonical")) out.push(m[1].trim());
  }
  return out;
}

export function readCanonicals(html: string, headers: Record<string, string>, pageUrl: string): CanonicalSource[] {
  const clean = stripComments(html);
  const headEnd = headOf(clean).length;
  const abs = (href: string) => {
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return null;
    }
  };
  const fromHtml = findTags(clean, "link")
    .filter((t) => relTokens(t.attrs.rel).includes("canonical"))
    .map<CanonicalSource>((t) => ({
      source: "html",
      href: t.attrs.href ?? "",
      absolute: t.attrs.href ? abs(t.attrs.href) : null,
      inHead: t.index < headEnd,
    }));
  const fromHeader = canonicalsFromLinkHeader(headers.link).map<CanonicalSource>((href) => ({
    source: "header",
    href,
    absolute: abs(href),
    inHead: true,
  }));
  return [...fromHtml, ...fromHeader];
}

export function isNoindex(html: string, headers: Record<string, string>): boolean {
  const meta = metaMap(headOf(stripComments(html)));
  const robots = [...(meta.get("robots") ?? []), ...(meta.get("googlebot") ?? [])].join(",");
  return /noindex|(^|[\s,])none([\s,]|$)/i.test(`${robots},${headers["x-robots-tag"] ?? ""}`);
}

/** How two URLs differ, in the terms that matter for a canonical. Null when identical. */
export function urlDifference(a: string, b: string): string | null {
  if (a === b) return null;
  const ua = new URL(a);
  const ub = new URL(b);
  const diffs: string[] = [];
  if (ua.protocol !== ub.protocol) diffs.push(`${ua.protocol.replace(":", "")} vs ${ub.protocol.replace(":", "")}`);
  if (ua.host !== ub.host) {
    const bare = (h: string) => h.replace(/^www\./, "");
    diffs.push(bare(ua.host) === bare(ub.host) ? "www vs non-www" : `a different host (${ub.host})`);
  }
  if (ua.pathname !== ub.pathname) {
    const strip = (p: string) => p.replace(/\/+$/, "");
    diffs.push(strip(ua.pathname) === strip(ub.pathname) ? "trailing slash" : `a different path (${ub.pathname})`);
  }
  if (ua.search !== ub.search) diffs.push("query string");
  return diffs.length ? diffs.join(", ") : null;
}

interface TargetCheck {
  items: KvItem[];
  chain: (string | number | null)[][];
}

async function checkTarget(target: string, pageUrl: string, ctx: ToolContext): Promise<TargetCheck> {
  const items: KvItem[] = [];
  const chain: (string | number | null)[][] = [];
  let first: SafeFetchResult;
  try {
    first = await ctx.fetch(target, { signal: ctx.signal, followRedirects: false });
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      items.push({ label: "Canonical target", value: `not fetched: ${err.message}`, status: "fail" });
      return { items, chain };
    }
    items.push({ label: "Canonical target", value: `could not be fetched: ${err instanceof FetchFailedError ? err.message : "request failed"}`, status: "fail" });
    return { items, chain };
  }
  chain.push([target, first.status, first.headers.location ?? null]);

  let final = first;
  if (first.status >= 300 && first.status < 400 && first.headers.location) {
    items.push({ label: "Canonical target", value: `redirects (HTTP ${first.status}). A canonical should name the final URL, not a redirect.`, status: "fail" });
    try {
      final = await ctx.fetch(target, { signal: ctx.signal });
      for (const hop of final.redirects.slice(1)) chain.push([hop.url, hop.status, hop.location]);
      chain.push([final.url, final.status, null]);
      items.push({ label: "Redirect ends at", value: `${final.url} (HTTP ${final.status})`, status: final.status === 200 ? "info" : "fail" });
    } catch (err) {
      items.push({ label: "Redirect chain", value: `fails: ${err instanceof Error ? err.message : "request failed"}`, status: "fail" });
      return { items, chain };
    }
  } else if (first.status === 200) {
    items.push({ label: "Canonical target", value: "answers HTTP 200", status: "pass" });
  } else {
    items.push({ label: "Canonical target", value: `answers HTTP ${first.status}. A canonical must point at a working page.`, status: "fail" });
    return { items, chain };
  }

  if (final.status === 200) {
    const noindex = isNoindex(final.body, final.headers);
    items.push({
      label: "Target indexable",
      value: noindex ? "no: the target is noindex, so the canonical asks to index a page that refuses it" : "yes",
      status: noindex ? "fail" : "pass",
    });
    const own = readCanonicals(final.body, final.headers, final.url).find((c) => c.absolute);
    if (own?.absolute) {
      const diff = urlDifference(final.url, own.absolute);
      items.push(
        diff
          ? { label: "Target's own canonical", value: `${own.absolute}: a chain. The target defers to yet another URL (${diff}).`, status: "fail" }
          : { label: "Target's own canonical", value: "points to itself", status: "pass" },
      );
      if (diff && own.absolute === pageUrl) {
        items.push({ label: "Loop", value: "the two pages name each other as canonical", status: "fail" });
      }
    } else {
      items.push({ label: "Target's own canonical", value: "none", status: "info" });
    }
  }
  return { items, chain };
}

export const canonicalChecker = defineTool({
  slug: "canonical-checker",
  kind: "fetch",
  input: z.object({ url: publicUrl }),
  perIpLimit: { limit: 30, windowMs: 60 * 60 * 1000 },
  estimateCents: 0,
  async run({ url }, ctx) {
    let res: SafeFetchResult;
    try {
      res = await ctx.fetch(url, { signal: ctx.signal });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new ToolError("invalid_input", err.message);
      throw new ToolError("upstream", `Could not fetch ${url}: ${err instanceof FetchFailedError ? err.message : "the request failed"}.`);
    }

    const page = res.url;
    const items: KvItem[] = [{ label: "Checked", value: page, status: "info" }];
    if (res.redirects.length) {
      items.push({ label: "Requested URL", value: `${url} redirects (${res.redirects.map((r) => r.status).join(" → ")}) to the page checked`, status: "info" });
    }
    items.push({ label: "HTTP status", value: String(res.status), status: res.status === 200 ? "pass" : "fail" });

    const canon = readCanonicals(res.body, res.headers, page);
    const html = canon.filter((c) => c.source === "html");
    const header = canon.filter((c) => c.source === "header");
    const distinct = [...new Set(canon.map((c) => c.absolute ?? c.href))];
    const blocks: Block[] = [];
    const notes: string[] = [];

    if (!canon.length) {
      items.push({
        label: "Canonical",
        value: "none. Search engines will choose one themselves; a self-referencing canonical makes the choice explicit.",
        status: "warn",
      });
      blocks.push(kv(items, "Canonical"));
      return blocks;
    }

    items.push({ label: "In the HTML", value: html.length ? html.map((c) => c.href || "(empty href)").join(", ") : "none", status: html.length > 1 ? "fail" : "info" });
    items.push({ label: "In the Link header", value: header.length ? header.map((c) => c.href).join(", ") : "none", status: header.length > 1 ? "fail" : "info" });

    if (distinct.length > 1) {
      items.push({ label: "Conflict", value: `${distinct.length} different canonicals. Search engines ignore all of them when they disagree.`, status: "fail" });
    } else if (canon.length > 1) {
      items.push({ label: "Duplicates", value: `the same canonical is declared ${canon.length} times; harmless but worth tidying`, status: "info" });
    }
    if (html.some((c) => !c.inHead)) {
      items.push({ label: "Placement", value: "a canonical link is in <body>. Google ignores canonicals outside <head>.", status: "fail" });
    }
    if (canon.some((c) => !c.href)) items.push({ label: "Empty", value: "a canonical has no href", status: "fail" });

    const chosen = canon.find((c) => c.absolute) ?? null;
    if (!chosen?.absolute) {
      items.push({ label: "Canonical URL", value: "could not be resolved to a URL", status: "fail" });
      blocks.push(kv(items, "Canonical"));
      return blocks;
    }
    const relative = !/^https?:\/\//i.test(chosen.href);
    items.push({
      label: "Absolute",
      value: relative ? `no (${chosen.href}). Valid, but an absolute URL avoids mistakes on staging hosts and in syndication.` : "yes",
      status: relative ? "warn" : "pass",
    });

    const diff = urlDifference(page, chosen.absolute);
    if (!diff) {
      items.push({ label: "Self-referencing", value: "yes: the page names itself as canonical", status: "pass" });
    } else {
      const cosmetic = /^(https? vs https?|www vs non-www|trailing slash)(, (https? vs https?|www vs non-www|trailing slash))*$/.test(diff);
      items.push({
        label: "Self-referencing",
        value: `no: it points to ${chosen.absolute} (differs by ${diff})`,
        status: cosmetic ? "warn" : "info",
      });
      if (cosmetic) {
        notes.push(`The canonical differs from this URL only by ${diff}. Pick one form and redirect the other to it, or this page competes with its own canonical.`);
      }
      if (new URL(chosen.absolute).protocol === "http:" && new URL(page).protocol === "https:") {
        notes.push("The canonical downgrades https to http.");
      }
    }

    if (isNoindex(res.body, res.headers) && diff) {
      items.push({ label: "Mixed signals", value: "the page is noindex AND canonicalises elsewhere. Use one or the other.", status: "warn" });
    }

    blocks.push(kv(items, "Canonical"));
    if (diff) {
      const target = await checkTarget(chosen.absolute, page, ctx);
      blocks.push(kv(target.items, "The canonical target"));
      if (target.chain.length > 1) blocks.push(table(["URL", "HTTP", "Redirects to"], target.chain, "Target redirect chain"));
    }
    if (notes.length) blocks.push(list(notes, "What to fix"));
    return blocks;
  },
});

// ---------------------------------------------------------------------------
// What one fetched page says about itself, with no second request
// ---------------------------------------------------------------------------
//
// The first look already holds the homepage's response - status, headers and
// HTML - because the readiness check and the crawl share one recording
// fetcher. Everything below is read off that response: the server, whether it
// compresses, how much of the page is words, how the headings nest, which
// social tags are set, what blocks the first paint. It is the part of a
// site report a person can act on this afternoon, and it costs nothing to
// produce because the bytes are already in memory.

export interface PageFacts {
  status: number;
  /** The `server` header, or null when the host does not say. */
  server: string | null;
  /** `content-encoding`, or null when the response was not compressed. */
  encoding: string | null;
  /** `cache-control` allows caching by a shared cache. */
  cacheable: boolean | null;
  htmlBytes: number;
  /** Characters of visible text; markup, scripts and styles removed. */
  textChars: number;
  /** textChars over htmlBytes, 0-100. */
  textRatio: number;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  viewport: boolean;
  canonical: string | null;
  lang: string | null;
  headings: { h1: number; h2: number; h3: number; h4: number };
  /** `og:*` and `twitter:*` properties that are set, e.g. "og:title". */
  socialTags: string[];
  /** Scripts in <head> that block parsing: no async, defer or type=module. */
  renderBlockingScripts: number;
  /** Stylesheets in <head>, which always block first paint. */
  renderBlockingStylesheets: number;
  /** JSON-LD @type values found, e.g. "Organization". */
  schemaTypes: string[];
  images: { total: number; missingAlt: number };
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return null;
}

export function pageFacts(html: string, headers: Record<string, string> = {}, status = 200): PageFacts {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html.slice(0, 200_000) : html.slice(0, headEnd);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decode(titleMatch[1]) : null;

  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  let metaDescription: string | null = null;
  let viewport = false;
  const social = new Set<string>();
  for (const tag of metas) {
    const name = (attr(tag, "name") ?? "").toLowerCase();
    const property = (attr(tag, "property") ?? "").toLowerCase();
    if (name === "description" && metaDescription === null) metaDescription = attr(tag, "content");
    if (name === "viewport") viewport = true;
    const key = property || name;
    if (/^(og|twitter):/.test(key)) social.add(key);
  }

  const canonicalTag = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonical = canonicalTag ? attr(canonicalTag, "href") : null;

  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? "";
  const lang = attr(htmlTag, "lang");

  const count = (level: number) => (html.match(new RegExp(`<h${level}\\b`, "gi")) ?? []).length;

  let renderBlockingScripts = 0;
  for (const m of head.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\ssrc\s*=/i.test(tag)) continue;
    if (/\s(async|defer)\b/i.test(tag)) continue;
    if (/\stype\s*=\s*["']?module/i.test(tag)) continue;
    renderBlockingScripts++;
  }
  let renderBlockingStylesheets = 0;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).includes("stylesheet") && !/\smedia\s*=\s*["']?print/i.test(tag)) renderBlockingStylesheets++;
  }

  const schemaTypes = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]) as unknown;
      const walk = (v: unknown) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === "object") {
          const t = (v as { "@type"?: unknown })["@type"];
          if (typeof t === "string") schemaTypes.add(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && schemaTypes.add(x));
          const g = (v as { "@graph"?: unknown })["@graph"];
          if (g) walk(g);
        }
      };
      walk(parsed);
    } catch {
      // Malformed JSON-LD is a finding for the readiness check, not this one.
    }
  }

  const imgTags = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const missingAlt = imgTags.filter((t) => {
    const alt = attr(t, "alt");
    return alt === null || alt === "";
  }).length;

  const text = decode(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
  const htmlBytes = Buffer.byteLength(html, "utf8");
  const cacheControl = headerOf(headers, "cache-control");
  const cacheable =
    cacheControl === null
      ? null
      : !/\b(no-store|private)\b/i.test(cacheControl) && (/\bmax-age=([1-9]\d*)/i.test(cacheControl) || /\bs-maxage=([1-9]\d*)/i.test(cacheControl) || /\bpublic\b/i.test(cacheControl));

  return {
    status,
    server: headerOf(headers, "server"),
    encoding: headerOf(headers, "content-encoding"),
    cacheable,
    htmlBytes,
    textChars: text.length,
    textRatio: htmlBytes ? Math.round((1000 * text.length) / htmlBytes) / 10 : 0,
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    viewport,
    canonical,
    lang,
    headings: { h1: count(1), h2: count(2), h3: count(3), h4: count(4) },
    socialTags: [...social].sort(),
    renderBlockingScripts,
    renderBlockingStylesheets,
    schemaTypes: [...schemaTypes].sort(),
    images: { total: imgTags.length, missingAlt },
  };
}

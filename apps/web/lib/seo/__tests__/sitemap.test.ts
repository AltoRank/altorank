import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { discoverSitemapEntries, parseLastmod, parseSitemap, sitemapText, type SitemapFetch } from "../sitemap";

const ORIGIN = "https://acme-agency.example";

const urlset = (rows: Array<[string, string?]>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(([loc, lastmod]) => `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;

const index = (rows: Array<[string, string?]>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map(([loc, lastmod]) => `  <sitemap><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</sitemap>`).join("\n")}
</sitemapindex>`;

/** A fake site: path -> body (string or bytes). Records every fetch in order. */
function site(files: Record<string, string | Buffer>) {
  const calls: string[] = [];
  const fetch: SitemapFetch = async (url) => {
    calls.push(url);
    const f = files[url];
    if (f === undefined) return { status: 404, body: "not found" };
    return typeof f === "string" ? { status: 200, body: f, bytes: Buffer.from(f) } : { status: 200, body: f.toString("latin1"), bytes: f };
  };
  return { fetch, calls };
}

describe("parseSitemap", () => {
  it("reads a urlset with lastmod, entities, CDATA and a namespace prefix", () => {
    const p = parseSitemap(`<?xml version="1.0"?>
<ns:urlset xmlns:ns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <ns:url><ns:loc>https://acme-agency.example/blog/a?x=1&amp;y=2</ns:loc><ns:lastmod>2026-09-22T14:30:00+03:00</ns:lastmod></ns:url>
  <ns:url><ns:loc><![CDATA[https://acme-agency.example/blog/b]]></ns:loc></ns:url>
</ns:urlset>`);
    expect(p.kind).toBe("urlset");
    expect(p.entries).toEqual([
      { loc: "https://acme-agency.example/blog/a?x=1&y=2", lastmod: "2026-09-22T11:30:00.000Z" },
      { loc: "https://acme-agency.example/blog/b", lastmod: null },
    ]);
  });

  it("tells an index from a urlset by its root element, not by file names", () => {
    const p = parseSitemap(index([["https://acme-agency.example/sitemap-posts", "2026-09-20"]]));
    expect(p.kind).toBe("index");
    expect(p.entries[0]).toEqual({ loc: "https://acme-agency.example/sitemap-posts", lastmod: "2026-09-20T00:00:00.000Z" });
  });

  it("reads the plain-text format, one URL per line", () => {
    const p = parseSitemap("https://acme-agency.example/\nhttps://acme-agency.example/blog/a\n\nnot a url\n");
    expect(p.kind).toBe("text");
    expect(p.entries.map((e) => e.loc)).toEqual(["https://acme-agency.example/", "https://acme-agency.example/blog/a"]);
  });

  it("calls an HTML error page served with 200 what it is: not a sitemap", () => {
    expect(parseSitemap("<!doctype html><html><body>Sayfa bulunamadı</body></html>").kind).toBe("unknown");
  });

  it("parses W3C dates and refuses anything else", () => {
    expect(parseLastmod("2026-09-22")).toBe("2026-09-22T00:00:00.000Z");
    expect(parseLastmod("2026-09-22T10:00Z")).toBe("2026-09-22T10:00:00.000Z");
    expect(parseLastmod("22/09/2026")).toBeNull();
    expect(parseLastmod("yesterday")).toBeNull();
    expect(parseLastmod(null)).toBeNull();
  });
});

describe("sitemapText", () => {
  it("inflates a gzipped sitemap served as a file", () => {
    const xml = urlset([["https://acme-agency.example/blog/a"]]);
    const gz = gzipSync(Buffer.from(xml));
    expect(sitemapText({ status: 200, body: gz.toString("latin1"), bytes: gz })).toBe(xml);
  });

  it("returns null for a truncated gzip rather than half a sitemap", () => {
    const gz = gzipSync(Buffer.from(urlset([["https://acme-agency.example/blog/a"]])));
    const cut = gz.subarray(0, 12);
    expect(sitemapText({ status: 200, body: "", bytes: cut })).toBeNull();
  });
});

describe("discoverSitemapEntries", () => {
  it("reads the sitemaps robots.txt declares, and not the conventional paths", async () => {
    const s = site({
      [`${ORIGIN}/sitemaps/pages.xml`]: urlset([[`${ORIGIN}/blog/a`, "2026-09-22"]]),
      [`${ORIGIN}/sitemap.xml`]: urlset([[`${ORIGIN}/should-not-be-read`]]),
    });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch, { declared: [`${ORIGIN}/sitemaps/pages.xml`] });
    expect(d.entries.map((e) => e.loc)).toEqual([`${ORIGIN}/blog/a`]);
    expect(s.calls).toEqual([`${ORIGIN}/sitemaps/pages.xml`]);
  });

  it("falls back to /sitemap.xml, then the index spellings, stopping at the first that is a sitemap", async () => {
    const s = site({ [`${ORIGIN}/sitemap_index.xml`]: urlset([[`${ORIGIN}/blog/a`]]) });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch);
    expect(d.entries.map((e) => e.loc)).toEqual([`${ORIGIN}/blog/a`]);
    expect(s.calls).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap_index.xml`]);
    expect(d.sitemapsFailed).toEqual([`${ORIGIN}/sitemap.xml`]);
  });

  it("follows an index, newest child first, including a gzipped child", async () => {
    const posts = gzipSync(Buffer.from(urlset([[`${ORIGIN}/blog/new-post`, "2026-09-22T09:00:00Z"]])));
    const s = site({
      [`${ORIGIN}/sitemap.xml`]: index([
        [`${ORIGIN}/old-sitemap.xml`, "2019-01-01"],
        [`${ORIGIN}/post-sitemap.xml.gz`, "2026-09-22"],
      ]),
      [`${ORIGIN}/post-sitemap.xml.gz`]: posts,
      [`${ORIGIN}/old-sitemap.xml`]: urlset([[`${ORIGIN}/blog/old-post`, "2019-01-01"]]),
    });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch);
    expect(s.calls).toEqual([`${ORIGIN}/sitemap.xml`, `${ORIGIN}/post-sitemap.xml.gz`, `${ORIGIN}/old-sitemap.xml`]);
    expect(d.entries).toEqual([
      { loc: `${ORIGIN}/blog/new-post`, lastmod: "2026-09-22T09:00:00.000Z" },
      { loc: `${ORIGIN}/blog/old-post`, lastmod: "2019-01-01T00:00:00.000Z" },
    ]);
  });

  it("stops at the sitemap cap and says the walk was cut short", async () => {
    const children = Array.from({ length: 5 }, (_, i) => `${ORIGIN}/s${i}.xml`);
    const files: Record<string, string> = { [`${ORIGIN}/sitemap.xml`]: index(children.map((c) => [c])) };
    children.forEach((c, i) => (files[c] = urlset([[`${ORIGIN}/p${i}`]])));
    const s = site(files);
    const d = await discoverSitemapEntries(ORIGIN, s.fetch, { maxSitemaps: 3 });
    expect(s.calls).toHaveLength(3);
    expect(d.entries).toHaveLength(2);
    expect(d.truncated).toBe(true);
  });

  it("keeps the later lastmod when two sitemaps list one URL, and caps the URL count", async () => {
    const s = site({
      [`${ORIGIN}/a.xml`]: urlset([[`${ORIGIN}/p`, "2026-09-01"], [`${ORIGIN}/q`]]),
      [`${ORIGIN}/b.xml`]: urlset([[`${ORIGIN}/p`, "2026-09-20"], [`${ORIGIN}/r`], [`${ORIGIN}/s`]]),
    });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch, { declared: [`${ORIGIN}/a.xml`, `${ORIGIN}/b.xml`], maxUrls: 3 });
    expect(d.entries).toEqual([
      { loc: `${ORIGIN}/p`, lastmod: "2026-09-20T00:00:00.000Z" },
      { loc: `${ORIGIN}/q`, lastmod: null },
      { loc: `${ORIGIN}/r`, lastmod: null },
    ]);
    expect(d.truncated).toBe(true);
  });

  it("does not fetch an index child robots.txt disallows, but reads a declared sitemap regardless", async () => {
    const s = site({
      [`${ORIGIN}/declared.xml`]: index([[`${ORIGIN}/private/s.xml`], [`${ORIGIN}/public/s.xml`]]),
      [`${ORIGIN}/public/s.xml`]: urlset([[`${ORIGIN}/blog/a`]]),
      [`${ORIGIN}/private/s.xml`]: urlset([[`${ORIGIN}/private/x`]]),
    });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch, {
      declared: [`${ORIGIN}/declared.xml`],
      allowed: (u) => !u.includes("/private/") && !u.includes("declared"),
    });
    expect(s.calls).toEqual([`${ORIGIN}/declared.xml`, `${ORIGIN}/public/s.xml`]);
    expect(d.entries.map((e) => e.loc)).toEqual([`${ORIGIN}/blog/a`]);
  });

  it("returns what it has when the deadline passes, rather than throwing", async () => {
    const s = site({ [`${ORIGIN}/sitemap.xml`]: urlset([[`${ORIGIN}/blog/a`]]) });
    const d = await discoverSitemapEntries(ORIGIN, s.fetch, { deadline: Date.now() - 1 });
    expect(d.entries).toEqual([]);
    expect(d.truncated).toBe(true);
    expect(s.calls).toEqual([]);
  });

  it("survives a fetch that throws", async () => {
    const d = await discoverSitemapEntries(ORIGIN, async () => {
      throw new Error("ECONNRESET");
    });
    expect(d.entries).toEqual([]);
    expect(d.sitemapsFailed).toHaveLength(3);
  });
});

import { describe, it, expect } from "vitest";
import { crawlPage, recordLinkedPages } from "../site-crawl";
import { crawlSite } from "@/lib/audit/crawler";
import { extractSitePage } from "@/lib/audit/site-extract";

// Both crawls now keep what a business page says about the business
// (migration 095). The sitemap crawl stores it with the rest of the row; the
// homepage-first crawl in the first look - the only reader of a hand-built
// site with no sitemap, like a real signup's on 2026-09-22 - records the
// pages it reached without ever overwriting what the sitemap crawl wrote.

const serve = (body: string) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

describe("crawlPage keeps the extract", () => {
  it("on a business page, and not on a post", async () => {
    const about = `<html><head><title>Hakkımızda</title></head><body><main><h1>Hakkımızda</h1><p>Örnek Ajans 2012 yılında kuruldu.</p><p>${"Kelime ".repeat(80)}</p></main></body></html>`;
    let restore = serve(about);
    try {
      const p = await crawlPage("https://ornek-ajans.example/hakkimizda", { domain: "ornek-ajans.example" });
      expect(p.extract).toMatchObject({ role: "about", stated: [{ kind: "founded", text: "Örnek Ajans 2012 yılında kuruldu." }] });
    } finally {
      restore();
    }
    const post = `<html><head><title>Contact forms</title><meta property="article:published_time" content="2026-01-01T00:00:00Z"></head><body><main><h1>Contact</h1><p>${"word ".repeat(80)}</p></main></body></html>`;
    restore = serve(post);
    try {
      const p = await crawlPage("https://acme-agency.example/contact-forms-guide", { domain: "acme-agency.example" });
      expect(p.page_type).toBe("article");
      expect(p.extract).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("crawlPage judges the extract on where the redirects ended", () => {
  const home = `<html><head><title>Örnek Ajans</title></head><body><main><h1>Örnek Ajans</h1><h2>Mobil Uygulama</h2><p>${"kelime ".repeat(80)}</p></main></body></html>`;

  /** `/iletisim` answers 301 to the homepage; everything else serves the homepage. */
  function redirectToHome() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/iletisim")) return new Response("", { status: 301, headers: { location: "/" } });
      return new Response(home, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  it("keeps no extract for a page that redirected to the homepage", async () => {
    const restore = redirectToHome();
    try {
      const p = await crawlPage("https://ornek-ajans.example/iletisim", { domain: "ornek-ajans.example" });
      expect(p.status).toBe(200);
      expect(p.extract).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("the link crawl judges the extract on where the redirects ended", () => {
  const home = `<html><head><title>Örnek Ajans</title></head><body><nav><a href="/iletisim">İletişim</a><a href="/hakkimizda">Hakkımızda</a></nav><main><h1>Örnek Ajans</h1></main></body></html>`;
  const about = `<html><head><title>Hakkımızda</title></head><body><main><h1>Hakkımızda</h1><p>Örnek Ajans 2012 yılında kuruldu.</p></main></body></html>`;

  it("stores nothing for a nav link that lands on the homepage, and keys a real page on where it ended", async () => {
    const original = globalThis.fetch;
    // `fetch` follows redirects itself; the Response says where it ended.
    const served = (body: string, url: string) => {
      const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: url });
      return res;
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/iletisim")) return served(home, "https://ornek-ajans.example/");
      if (url.endsWith("/hakkimizda")) return served(about, "https://ornek-ajans.example/tr/hakkimizda");
      return served(home, "https://ornek-ajans.example/");
    }) as typeof fetch;
    try {
      const pages = await crawlSite("https://ornek-ajans.example/", 10, 1, 0);
      const contact = pages.find((p) => p.url.endsWith("/iletisim"));
      expect(contact).toMatchObject({ status: 200, finalUrl: "https://ornek-ajans.example/", extract: null });
      const aboutPage = pages.find((p) => p.url.endsWith("/hakkimizda"));
      expect(aboutPage?.extract).toMatchObject({ role: "about" });

      const { db, upserts } = fakeDb([]);
      await recordLinkedPages(db, "ws-1", pages);
      expect(upserts[0].rows.map((r) => r.url)).toEqual(["https://ornek-ajans.example/", "https://ornek-ajans.example/tr/hakkimizda"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Just enough of the Supabase client for recordLinkedPages. */
function fakeDb(existing: { url: string; extract: unknown }[]) {
  const upserts: Array<{ rows: Record<string, unknown>[]; opts: unknown }> = [];
  const updates: Array<{ patch: unknown; filters: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => {
      expect(table).toBe("site_pages");
      return {
        select: () => ({ eq: () => ({ limit: async () => ({ data: existing, error: null }) }) }),
        upsert: async (rows: Record<string, unknown>[], opts: unknown) => {
          upserts.push({ rows, opts });
          return { error: null };
        },
        update: (patch: unknown) => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq: (k: string, v: unknown) => {
              filters[k] = v;
              return chain;
            },
            is: async (k: string, v: unknown) => {
              filters[`is:${k}`] = v;
              updates.push({ patch, filters });
              return { error: null };
            },
          };
          return chain;
        },
      };
    },
  };
  return { db: db as never, upserts, updates };
}

const page = (url: string, status: number, html: string) => ({
  url,
  status,
  title: "",
  metaDescription: "",
  h1: [] as string[],
  extract: extractSitePage(html, url),
});

describe("recordLinkedPages", () => {
  const services = `<html><body><main><h1>Our services</h1><h2>Web design</h2></main></body></html>`;
  const contact = `<html><body><main><h1>Contact</h1><p>Based in Leeds, near the station.</p></main></body></html>`;
  const terms = `<html><body><main><h1>Terms</h1></main></body></html>`;

  it("inserts new business pages, fills an extract the sitemap row lacks, and overwrites nothing", async () => {
    const { db, upserts, updates } = fakeDb([
      { url: "https://www.acme-agency.example/contact/", extract: null },
      { url: "https://acme-agency.example/services", extract: { v: 1, role: "offering" } },
    ]);
    const out = await recordLinkedPages(db, "ws-1", [
      page("https://acme-agency.example/about-us", 200, `<html><body><main><h1>About us</h1></main></body></html>`),
      // Same page as the sitemap row, spelled differently: fill, do not duplicate.
      page("https://acme-agency.example/contact", 200, contact),
      // Already has an extract: left alone.
      page("https://acme-agency.example/services", 200, services),
      // No role: nothing to keep.
      page("https://acme-agency.example/terms", 200, terms),
      // Did not answer 2xx: not a page we can say exists.
      page("https://acme-agency.example/pricing", 404, `<html><body><main><h1>Pricing</h1></main></body></html>`),
    ]);
    expect(out).toEqual({ inserted: 1, updated: 1, error: null });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].opts).toEqual({ onConflict: "workspace_id,url", ignoreDuplicates: true });
    expect(upserts[0].rows).toEqual([
      expect.objectContaining({
        workspace_id: "ws-1",
        url: "https://acme-agency.example/about-us",
        path: "/about-us",
        page_type: "page",
        status: 200,
        h1: "About us",
        extract: expect.objectContaining({ role: "about" }),
      }),
    ]);
    // No scores and no keyword: the link pool and the refresh queue filter on those.
    expect(upserts[0].rows[0]).not.toHaveProperty("keyword");
    expect(upserts[0].rows[0]).not.toHaveProperty("seo_score");
    expect(updates).toEqual([
      {
        patch: { extract: expect.objectContaining({ role: "contact" }) },
        filters: { workspace_id: "ws-1", url: "https://www.acme-agency.example/contact/", "is:extract": null },
      },
    ]);
  });

  it("says why when it cannot read the table, and throws nothing", async () => {
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "column site_pages.extract does not exist" } }) }) }) }),
    } as never;
    const out = await recordLinkedPages(db, "ws-1", [page("https://acme-agency.example/contact", 200, contact)]);
    expect(out).toEqual({ inserted: 0, updated: 0, error: "column site_pages.extract does not exist" });
  });
});

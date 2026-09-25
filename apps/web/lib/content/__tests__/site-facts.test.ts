import { describe, it, expect } from "vitest";
import { buildSiteFacts, conversionCandidates, loadSiteFacts, resolveConversionPage, type SitePageRow } from "../site-facts";
import { extractSitePage } from "@/lib/audit/site-extract";
import { buildSystemPrompt, buildSiteFactsSection } from "@/lib/ai/prompts";
import { fakeFetch } from "@/lib/public-tools/__tests__/fake-fetch";

// A real signup, 2026-09-22 (Turkish web/mobile agency): the first article
// marketed the category, because the writer got three profile fields and none
// of the services, portfolio, about or contact pages the crawl had read. The
// pages below are invented; the shape is his.

const DOMAIN = "ornek-ajans.example";
const O = `https://${DOMAIN}`;
const NOW = new Date("2026-09-25T00:00:00Z");

const shell = (title: string, main: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/iletisim">İletişim</a></nav><main>${main}</main></body></html>`;

function row(url: string, html: string, status = 200): SitePageRow {
  return { url, title: null, h1: null, page_type: "page", status, extract: extractSitePage(html, url, { now: NOW }) };
}

const ROWS: SitePageRow[] = [
  row(`${O}/`, shell("Örnek Ajans", `<h1>Örnek Ajans</h1><p>2012'den beri mobil uygulama geliştiriyoruz.</p>`)),
  row(
    `${O}/hizmetler`,
    shell(
      "Hizmetlerimiz",
      `<h1>Hizmetlerimiz</h1><h2>Mobil Uygulama Geliştirme</h2><h2>Neden Biz?</h2>
       <p><a href="/hizmetler/mobil-uygulama">Mobil Uygulama Geliştirme</a>
          <a href="/hizmetler/web-tasarim">Web Tasarım</a>
          <a href="/iletisim">Bize ulaşın</a></p>`,
    ),
  ),
  row(`${O}/hizmetler/mobil-uygulama`, shell("Mobil Uygulama Geliştirme", "<h1>Mobil Uygulama Geliştirme</h1><p>iOS ve Android.</p>")),
  row(
    `${O}/referanslar`,
    shell(
      "Referanslarımız",
      `<h1>Referanslarımız</h1>
       <a href="https://play.google.com/store/apps/details?id=com.example.kargo">Kargo Takip Uygulaması</a>
       <a href="/referanslar/lezzet-duragi">Lezzet Durağı Web Sitesi</a>`,
    ),
  ),
  row(`${O}/hakkimizda`, shell("Hakkımızda", "<h1>Hakkımızda</h1><p>Örnek Ajans 2012 yılında kuruldu.</p><p>15 kişilik ekibimizle çalışıyoruz.</p>")),
  row(`${O}/iletisim`, shell("İletişim", "<h1>İletişim</h1><p>Adres: Moda Cad. No:1 Kadıköy/İstanbul</p>")),
  // A page that did not answer contributes nothing, and is not a page the writer may link.
  row(`${O}/fiyatlar`, shell("Fiyatlar", "<h1>Fiyatlar</h1>"), 404),
  // A post: no extract.
  { url: `${O}/blog/uygulama-maliyeti`, title: "Uygulama maliyeti", h1: null, page_type: "article", status: 200, extract: null },
];

describe("buildSiteFacts", () => {
  const facts = buildSiteFacts(ROWS, DOMAIN);

  it("names what the business sells from its own pages, with a URL only for a page that was fetched", () => {
    expect(facts.pagesRead).toBe(7);
    expect(facts.offerings).toEqual([
      { name: "Mobil Uygulama Geliştirme", url: `${O}/hizmetler/mobil-uygulama` },
      // Linked from the services page, never fetched: named, not linkable.
      { name: "Web Tasarım", url: null },
    ]);
    // "Bize ulaşın" is a contact link on the services page, not a service.
    expect(facts.offerings.some((o) => o.name === "Bize ulaşın")).toBe(false);
  });

  it("keeps the portfolio's projects by the names the site uses, including the store link out", () => {
    expect(facts.work).toEqual([
      { name: "Kargo Takip Uygulaması", url: "https://play.google.com/store/apps/details?id=com.example.kargo" },
      { name: "Lezzet Durağı Web Sitesi", url: null },
    ]);
  });

  it("keeps what the about, home and contact pages state, with the page it came from", () => {
    expect(facts.stated).toEqual([
      { kind: "founded", text: "Örnek Ajans 2012 yılında kuruldu.", source: `${O}/hakkimizda` },
      { kind: "team", text: "15 kişilik ekibimizle çalışıyoruz.", source: `${O}/hakkimizda` },
      { kind: "founded", text: "2012'den beri mobil uygulama geliştiriyoruz.", source: `${O}/` },
      { kind: "location", text: "Adres: Moda Cad. No:1 Kadıköy/İstanbul", source: `${O}/iletisim` },
    ]);
  });

  it("keeps index headings apart from the named offerings, as the page's outline", () => {
    expect(facts.headings).toEqual([{ page: "Hizmetlerimiz", url: `${O}/hizmetler`, items: ["Mobil Uygulama Geliştirme", "Neden Biz?"] }]);
  });

  it("lists the section pages that exist, and not the one that answered 404", () => {
    expect(facts.pages.map((p) => p.url)).toEqual([`${O}/hizmetler`, `${O}/referanslar`, `${O}/hakkimizda`, `${O}/iletisim`]);
    expect(conversionCandidates(ROWS, DOMAIN)).toEqual([`${O}/iletisim`]);
  });

  it("says so when no page was recognised, and names the languages it can recognise", () => {
    const fi = buildSiteFacts([{ url: "https://example.fi/yhteystiedot", title: "Yhteystiedot", h1: null, status: 200, extract: null }], "example.fi");
    expect(fi.notes[0]).toMatch(/None of the 1 pages read was recognised/);
    expect(fi.notes[0]).toMatch(/English, Turkish, Italian, Spanish, French, German, Portuguese and Dutch/);
    expect(buildSiteFacts([], DOMAIN).notes[0]).toMatch(/No page of this site has been read yet/);
  });
});

describe("resolveConversionPage", () => {
  it("uses the saved page when it answers", async () => {
    const fetch = fakeFetch({ [`${O}/iletisim`]: { status: 200 } });
    const out = await resolveConversionPage({ stored: "/iletisim", candidates: [], domain: DOMAIN, fetch });
    expect(out.conversion).toEqual({ url: `${O}/iletisim`, check: "The saved conversion page answered HTTP 200 when this draft was written" });
  });

  it("replaces a saved page that answers 404 with the contact page the crawl read", async () => {
    const fetch = fakeFetch({ [`${O}/contact`]: { status: 404 }, [`${O}/iletisim`]: { status: 200 } });
    const out = await resolveConversionPage({ stored: `${O}/contact`, candidates: [`${O}/iletisim`], domain: DOMAIN, fetch });
    expect(out.conversion?.url).toBe(`${O}/iletisim`);
    expect(out.note).toMatch(/The saved conversion page https:\/\/ornek-ajans\.example\/contact answered HTTP 404, page gone; using https:\/\/ornek-ajans\.example\/iletisim instead/);
  });

  it("keeps a page shown to exist before when the site rate-limits the re-check, and says it was not re-checked", async () => {
    const fetch = fakeFetch({ [`${O}/iletisim`]: { status: 429 } });
    const out = await resolveConversionPage({ stored: null, candidates: [`${O}/iletisim`], domain: DOMAIN, fetch });
    expect(out.conversion?.check).toMatch(/not re-checked now \(HTTP 429, could not verify\)/);
  });

  it("does not use a never-verified saved page the site will not let us check", async () => {
    const fetch = fakeFetch({ [`${O}/iletisim`]: { status: 429 } });
    const out = await resolveConversionPage({ stored: "/iletisim", candidates: [], domain: DOMAIN, fetch });
    expect(out.conversion).toBeNull();
    expect(out.note).toMatch(/could not be checked/);
  });

  it("accepts a booking page a person typed on another host, checked like any other", async () => {
    const fetch = fakeFetch({ "https://booking.example/ornek": { status: 200 } });
    const out = await resolveConversionPage({ stored: "https://booking.example/ornek", candidates: [], domain: DOMAIN, fetch });
    expect(out.conversion?.url).toBe("https://booking.example/ornek");
  });

  it("returns none, with the reason, when nothing answers", async () => {
    const fetch = fakeFetch({ [`${O}/iletisim`]: { status: 404 } });
    const out = await resolveConversionPage({ stored: "/iletisim", candidates: [], domain: DOMAIN, fetch });
    expect(out).toEqual({ conversion: null, note: `No conversion page could be confirmed: ${O}/iletisim answered HTTP 404, page gone.` });
  });
});

describe("loadSiteFacts", () => {
  function db(rows: SitePageRow[], error: { message: string } | null = null) {
    const chain = {
      eq: () => chain,
      gte: () => chain,
      lt: () => chain,
      limit: async () => ({ data: error ? null : rows.filter((r) => (r.status ?? 0) >= 200 && (r.status ?? 0) < 300), error }),
    };
    return { from: () => ({ select: () => chain }) } as never;
  }

  it("builds the facts and re-checks the saved conversion page, for the research panel too", async () => {
    const fetch = fakeFetch({ [`${O}/iletisim`]: { status: 200 } });
    const { facts, layer } = await loadSiteFacts(db(ROWS), "ws-1", DOMAIN, { conversionUrl: "/iletisim" }, { fetch });
    expect(facts.conversion?.url).toBe(`${O}/iletisim`);
    expect(layer).toMatchObject({ id: "site_facts", status: "ok" });
    expect(layer.detail).toMatch(/^2 offerings, 2 pieces of work, 4 stated facts from 7 pages read\./);
  });

  it("says why when the table cannot be read, and throws nothing", async () => {
    const { facts, layer } = await loadSiteFacts(db([], { message: "column site_pages.extract does not exist" }), "ws-1", DOMAIN, null);
    expect(layer.status).toBe("failed");
    expect(facts.notes[0]).toMatch(/column site_pages\.extract does not exist/);
  });
});

describe("the writer prompt", () => {
  it("carries the business's own facts, the rule to market its offer with them, and the ban on inventing", async () => {
    const facts = buildSiteFacts(ROWS, DOMAIN);
    facts.conversion = { url: `${O}/iletisim`, check: "answered HTTP 200 when this draft was written" };
    const p = buildSystemPrompt({
      keyword: "mobil uygulama ajansı",
      language: "Turkish",
      site: { name: "Örnek Ajans", description: "İstanbul'da mobil uygulama ajansı.", audiences: [], offerings: ["mobil uygulama geliştirme"] },
      siteFacts: facts,
    });
    expect(p).toContain("WHAT THIS BUSINESS'S OWN SITE SAYS (read from 7 of its pages that answered):");
    expect(p).toContain(`- Mobil Uygulama Geliştirme: ${O}/hizmetler/mobil-uygulama`);
    expect(p).toContain("- Kargo Takip Uygulaması: https://play.google.com/store/apps/details?id=com.example.kargo");
    expect(p).toContain(`- "Örnek Ajans 2012 yılında kuruldu." (${O}/hakkimizda)`);
    expect(p).toContain(`Where a reader who is ready should go: ${O}/iletisim`);
    expect(p).toContain("Market its own offer with these facts, not the category.");
    expect(p).toContain("Never invent clients, projects, results, numbers,");
    expect(p).toContain("prices, years, team sizes");
    expect(p).toContain("What people buy from it, in the owner's confirmed words: mobil uygulama geliştirme");
    // No articles in the pool, but its own pages may be linked by exact URL.
    expect(p).toContain("INTERNAL LINKS — only the business's own pages listed above.");
    expect(p).not.toContain("INTERNAL LINKS — do not add any.");
  });

  it("tells the writer plainly when no conversion page could be confirmed", () => {
    const facts = buildSiteFacts([], DOMAIN);
    const section = buildSiteFactsSection(facts);
    expect(section).toContain("NO PAGE COULD BE CONFIRMED");
    expect(section).toContain("do not write a path such as /contact");
    expect(section).toContain("Do not fill that gap");
    // Nothing to link: the old "do not add any" rule stands.
    expect(buildSystemPrompt({ keyword: "k", siteFacts: facts })).toContain("INTERNAL LINKS — do not add any.");
  });

  it("allows the business's pages alongside the article pool, and nothing else on the site", () => {
    const facts = buildSiteFacts(ROWS, DOMAIN);
    const p = buildSystemPrompt({ keyword: "k", siteFacts: facts, internalLinkTargets: [{ keyword: "maliyet", title: "Uygulama maliyeti" }] });
    expect(p).toContain("apart from the business's own pages listed above by their URL");
    expect(p).toContain("A link to a page on neither list is removed before publishing.");
  });
});

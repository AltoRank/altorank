import { describe, it, expect } from "vitest";
import { extractFetchedPage, extractSitePage, fold, roleOf, statedFacts } from "../site-extract";

// A real signup, 2026-09-22 (Turkish web/mobile agency): the crawl read his
// services, portfolio, about and contact pages and kept only their titles, so
// the writer marketed the category instead of him. These pin what is kept,
// on invented pages in Turkish and English.

const page = (head: string, body: string) =>
  `<!doctype html><html><head>${head}</head><body><nav><a href="/">Ana sayfa</a><a href="/iletisim">İletişim</a></nav><main>${body}</main><footer><a href="/kvkk">KVKK</a></footer></body></html>`;

const NOW = new Date("2026-09-25T00:00:00Z");

describe("fold", () => {
  it("makes a Turkish heading and its slug the same word", () => {
    expect(fold("İletişim")).toBe("iletisim");
    expect(fold("HAKKIMIZDA")).toBe("hakkimizda");
    expect(fold("Hakkımızda")).toBe("hakkimizda");
    expect(fold("Über uns")).toBe("uber uns");
    expect(fold("Straße")).toBe("strasse");
  });
});

describe("roleOf", () => {
  it("reads the role off the path, in Turkish and English, past a locale segment", () => {
    expect(roleOf("https://ornek-ajans.example/iletisim")).toMatchObject({ role: "contact", roleFrom: "path", detail: false });
    expect(roleOf("https://ornek-ajans.example/tr/hizmetler/mobil-uygulama")).toMatchObject({ role: "offering", detail: true });
    // Percent-encoded Turkish slug, as a hand-built site serves it.
    expect(roleOf("https://ornek-ajans.example/hakk%C4%B1m%C4%B1zda")).toMatchObject({ role: "about" });
    expect(roleOf("https://acme-agency.example/case-studies/harbour-app")).toMatchObject({ role: "work", detail: true });
    expect(roleOf("https://acme-agency.example/pricing")).toMatchObject({ role: "pricing" });
    expect(roleOf("https://acme-agency.example/")).toMatchObject({ role: "home", roleFrom: "root" });
  });

  it("never takes a post for a business page, whatever its slug says", () => {
    expect(roleOf("https://acme-agency.example/blog/contact")).toBeNull();
    expect(roleOf("https://acme-agency.example/blog")).toBeNull();
    // Whole-segment match only: a slug that merely contains the word is not the page.
    expect(roleOf("https://acme-agency.example/how-to-contact-support")).toBeNull();
  });

  it("falls back to the page's own heading, then says nothing when nothing matches", () => {
    expect(roleOf("https://ornek-ajans.example/sayfa-7", { h1: "Referanslarımız" })).toMatchObject({ role: "work", roleFrom: "heading" });
    expect(roleOf("https://acme-agency.example/p/12", { title: "About us | Acme" })).toMatchObject({ role: "about", roleFrom: "heading" });
    // A language outside the table is not guessed at.
    expect(roleOf("https://example.fi/yhteystiedot", { h1: "Yhteystiedot" })).toBeNull();
  });

  it("takes a contact, pricing or about page nested under a section for what its own name says", () => {
    // `/kurumsal` ("corporate") is a common Turkish menu that holds the about
    // AND the contact page; the section is not what the page is.
    expect(roleOf("https://acme-agency.example/company/contact", { h1: "Contact us" })).toEqual({ role: "contact", roleFrom: "path", detail: false });
    expect(roleOf("https://ornek-ajans.example/kurumsal/iletisim", { h1: "İletişim" })).toEqual({ role: "contact", roleFrom: "path", detail: false });
    expect(roleOf("https://ornek-ajans.example/tr/kurumsal/hakkimizda")).toEqual({ role: "about", roleFrom: "path", detail: false });
    expect(roleOf("https://acme-agency.example/products/pricing")).toEqual({ role: "pricing", roleFrom: "path", detail: false });
    // A slug that names nothing, headed as the contact page, is the contact page.
    expect(roleOf("https://ornek-ajans.example/kurumsal/bize-yazin", { h1: "İletişim" })).toEqual({ role: "contact", roleFrom: "heading", detail: false });
    // And a slug that names nothing under a section, headed as nothing, is still one item of it.
    expect(roleOf("https://ornek-ajans.example/hizmetler/web-tasarim", { h1: "Web Tasarım" })).toEqual({ role: "offering", roleFrom: "path", detail: true });
  });

  it("trusts the page's structured data over its URL", () => {
    expect(roleOf("https://example.fi/yhteystiedot", { schemaTypes: ["ContactPage"] })).toMatchObject({ role: "contact", roleFrom: "schema" });
  });
});

describe("extractSitePage — Turkish", () => {
  it("keeps a services index's services and the links to their pages", () => {
    const html = page(
      "<title>Hizmetlerimiz | Örnek Ajans</title>",
      `<h1>Hizmetlerimiz</h1>
       <h2>Mobil Uygulama Geliştirme</h2><p>iOS ve Android için uygulamalar.</p>
       <h2>Web Tasarım</h2><p>Kurumsal siteler.</p>
       <h3>E-Ticaret Çözümleri</h3>
       <p><a href="/hizmetler/mobil-uygulama">Mobil Uygulama Geliştirme</a> <a href="/hizmetler/web-tasarim">Detaylar</a></p>`,
    );
    const x = extractSitePage(html, "https://ornek-ajans.example/hizmetler", { now: NOW });
    expect(x).toMatchObject({ role: "offering", detail: false, name: "Hizmetlerimiz" });
    expect(x!.headings).toEqual(["Mobil Uygulama Geliştirme", "Web Tasarım", "E-Ticaret Çözümleri"]);
    // "Detaylar" names nothing; the nav's İletişim link is outside <main>.
    expect(x!.links).toEqual([{ text: "Mobil Uygulama Geliştirme", url: "https://ornek-ajans.example/hizmetler/mobil-uygulama" }]);
  });

  it("keeps a portfolio's projects by the names the site uses, including links out to the live app", () => {
    const html = page(
      "<title>Referanslarımız</title>",
      `<h1>Referanslarımız</h1>
       <ul>
         <li><a href="https://play.google.com/store/apps/details?id=com.ornek.kargo&amp;hl=tr">Kargo Takip Uygulaması</a></li>
         <li><a href="/referanslar/lezzet-duragi">Lezzet Durağı Web Sitesi</a></li>
         <li><a href="/referanslar/lezzet-duragi">İncele</a></li>
       </ul>`,
    );
    const x = extractSitePage(html, "https://ornek-ajans.example/referanslar", { now: NOW });
    expect(x?.role).toBe("work");
    expect(x!.links).toEqual([
      { text: "Kargo Takip Uygulaması", url: "https://play.google.com/store/apps/details?id=com.ornek.kargo&hl=tr" },
      { text: "Lezzet Durağı Web Sitesi", url: "https://ornek-ajans.example/referanslar/lezzet-duragi" },
    ]);
  });

  it("keeps what the about page states, and only that", () => {
    const html = page(
      "<title>Hakkımızda</title>",
      `<h1>Hakkımızda</h1>
       <p>Örnek Ajans 2012 yılında kuruldu.</p>
       <p>15 kişilik ekibimizle mobil ve web projeleri geliştiriyoruz.</p>
       <p>İstanbul merkezli bir ajansız.</p>
       <p>Müşterilerimizin başarısı bizim başarımızdır.</p>`,
    );
    const x = extractSitePage(html, "https://ornek-ajans.example/hakkimizda", { now: NOW });
    expect(x?.role).toBe("about");
    expect(x!.stated).toEqual([
      { kind: "founded", text: "Örnek Ajans 2012 yılında kuruldu." },
      { kind: "team", text: "15 kişilik ekibimizle mobil ve web projeleri geliştiriyoruz." },
      { kind: "location", text: "İstanbul merkezli bir ajansız." },
    ]);
    expect(x!.text).toContain("Örnek Ajans 2012 yılında kuruldu.");
  });

  it("reads the address on a contact page that has no full stops between its lines", () => {
    const html = page(
      "<title>İletişim</title>",
      `<h1>İletişim</h1><p>Adres: Moda Cad. No:1 Kadıköy/İstanbul<br>Telefon: 0212 000 00 00</p>`,
    );
    const x = extractSitePage(html, "https://ornek-ajans.example/iletisim", { now: NOW });
    expect(x?.role).toBe("contact");
    expect(x!.stated).toEqual([{ kind: "location", text: "Adres: Moda Cad. No:1 Kadıköy/İstanbul" }]);
  });
});

describe("extractSitePage — English", () => {
  it("names one service from its detail page and keeps no list for it", () => {
    const html = page("<title>Web design | Acme</title>", "<h1>Web design</h1><h2>What you get</h2><p>Sites.</p>");
    const x = extractSitePage(html, "https://acme-agency.example/services/web-design", { now: NOW });
    expect(x).toMatchObject({ role: "offering", detail: true, name: "Web design", headings: [], links: [] });
  });

  it("keeps a case-study index's projects and drops 'Read more'", () => {
    const html = page(
      "<title>Our work</title>",
      `<h1>Our work</h1>
       <article><h2><a href="/work/harbour-bank-app">Harbour Bank app</a></h2><a href="/work/harbour-bank-app">Read more</a></article>
       <article><h2><a href="https://apps.apple.com/gb/app/tidal-notes/id000000">Tidal Notes</a></h2></article>`,
    );
    const x = extractSitePage(html, "https://acme-agency.example/work", { now: NOW });
    expect(x!.links.map((l) => l.text)).toEqual(["Harbour Bank app", "Tidal Notes"]);
    expect(x!.headings).toEqual(["Harbour Bank app", "Tidal Notes"]);
  });

  it("states founding, team and location from the about page and its structured data", () => {
    const html = page(
      `<title>About us - Acme</title><script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "AboutPage" },
          { "@type": "Organization", name: "Acme", foundingDate: "2014", address: { "@type": "PostalAddress", addressLocality: "Leeds", addressCountry: "GB" } },
        ],
      })}</script>`,
      `<h1>About Acme</h1><p>We are a team of 12 designers and developers.</p><p>We love good coffee.</p>`,
    );
    const x = extractSitePage(html, "https://acme-agency.example/company/who", { now: NOW });
    expect(x).toMatchObject({ role: "about", roleFrom: "schema" });
    expect(x!.stated).toEqual([
      // Values, not sentences: the page's JSON-LD has no words of the site's
      // to quote, and an English sentence around a value would be ours.
      { kind: "founded", text: "2014", from: "structured-data" },
      { kind: "location", text: "Leeds, GB", from: "structured-data" },
      { kind: "team", text: "We are a team of 12 designers and developers." },
    ]);
  });

  it("does not take a site-wide Organization's nested Service for this page's role", () => {
    const html = page(
      `<title>Careers</title><script type="application/ld+json">${JSON.stringify({
        "@type": "Organization", name: "Acme", makesOffer: { "@type": "Offer", itemOffered: { "@type": "Service", name: "Design" } },
      })}</script>`,
      "<h1>Careers</h1><p>Join us.</p>",
    );
    expect(extractSitePage(html, "https://acme-agency.example/careers", { now: NOW })).toBeNull();
  });

  it("keeps nothing for a page with no role, and nothing for a post", () => {
    expect(extractSitePage(page("<title>Terms</title>", "<h1>Terms</h1>"), "https://acme-agency.example/terms")).toBeNull();
    expect(
      extractSitePage(page("<title>Contact tips</title>", "<h1>Contact</h1>"), "https://acme-agency.example/blog/contact-tips"),
    ).toBeNull();
  });

  it("ignores a year that has not happened and a year with no founding word", () => {
    const facts = statedFacts("<p>Since 2031 we will be bigger.</p><p>Our 2019 report was popular.</p>", "", NOW);
    expect(facts).toEqual([]);
  });
});

describe("extractFetchedPage", () => {
  // A nav link to /iletisim that redirects to the homepage used to be stored
  // as a 2xx "contact" page carrying the homepage's content.
  const home = `<html><head><title>Örnek Ajans</title></head><body><main><h1>Örnek Ajans</h1><h2>Mobil Uygulama</h2></main></body></html>`;
  const contact = `<html><head><title>İletişim</title></head><body><main><h1>İletişim</h1><p>Adres: Moda Cad. No:1 Kadıköy/İstanbul</p></main></body></html>`;

  it("keeps nothing for a page that redirected to the homepage", () => {
    expect(extractFetchedPage(home, "https://ornek-ajans.example/iletisim", "https://ornek-ajans.example/")).toBeNull();
    // The homepage itself, asked for and served, is the home.
    expect(extractFetchedPage(home, "https://ornek-ajans.example/", "https://www.ornek-ajans.example/")).toMatchObject({ role: "home" });
  });

  it("reads the page where the redirects ended, not the URL asked for", () => {
    const out = extractFetchedPage(contact, "https://ornek-ajans.example/bize-yazin", "https://ornek-ajans.example/tr/iletisim");
    expect(out).toMatchObject({ role: "contact", roleFrom: "path" });
  });

  it("keeps nothing for a redirect off the site, and takes the URL asked for when no final URL is known", () => {
    expect(extractFetchedPage(contact, "https://ornek-ajans.example/iletisim", "https://forms.example/ornek")).toBeNull();
    expect(extractFetchedPage(contact, "https://ornek-ajans.example/iletisim", "")).toMatchObject({ role: "contact" });
  });
});


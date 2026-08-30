import { describe, it, expect } from "vitest";
import {
  decode,
  extractFaqPairs,
  extractSocialProfiles,
  proposeSchema,
  renderJsonLd,
  extractCopyrightName,
  nameMatchesDomain,
} from "../schema-generator";

const ldJson = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

const page = (head: string, body = "") =>
  `<html><head>${head}</head><body>${body}</body></html>`;

const URL_ = "https://acme.example/";

const orgOf = (html: string) =>
  proposeSchema(html, URL_).proposals.find((p) => p.type === "Organization");

// ── helpers ───────────────────────────────────────────────────────────────────

describe("decode", () => {
  it("resolves named and numeric entities and collapses whitespace", () => {
    expect(decode("Acme &amp; Co&#39;s\n\n  agency")).toBe("Acme & Co's agency");
  });

  it("resolves typographic entities, which the title splitter depends on", () => {
    expect(decode("Milano &ndash; SEO")).toBe("Milano – SEO");
    expect(decode("a &mdash; b")).toBe("a — b");
  });

  it("resolves hex numeric entities", () => {
    expect(decode("Milano &#x2013; SEO")).toBe("Milano – SEO");
  });

  it("leaves unknown named entities alone rather than mangling them", () => {
    expect(decode("a &zzz; b")).toBe("a &zzz; b");
  });
});

// ── sameAs ────────────────────────────────────────────────────────────────────

describe("extractSocialProfiles", () => {
  it("collects genuine profile links", () => {
    const html = `
      <a href="https://www.linkedin.com/company/acme">li</a>
      <a href="https://x.com/acme">x</a>
      <a href="https://www.instagram.com/acme.studio">ig</a>`;
    expect(extractSocialProfiles(html)).toEqual([
      "https://www.instagram.com/acme.studio",
      "https://www.linkedin.com/company/acme",
      "https://x.com/acme",
    ]);
  });

  it("excludes share and intent URLs, which are not the company's identity", () => {
    const html = `
      <a href="https://twitter.com/intent/tweet?url=x">tweet</a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
      <a href="https://www.linkedin.com/shareArticle?url=x">share</a>`;
    expect(extractSocialProfiles(html)).toEqual([]);
  });

  it("excludes platform policy and utility routes", () => {
    const html = `<a href="https://www.facebook.com/privacy">p</a>
                  <a href="https://x.com/explore">e</a>`;
    expect(extractSocialProfiles(html)).toEqual([]);
  });

  it("excludes bare platform roots that carry no identity", () => {
    expect(extractSocialProfiles(`<a href="https://twitter.com/">t</a>`)).toEqual([]);
  });

  it("deduplicates repeats across header and footer", () => {
    const html = `<a href="https://x.com/acme">a</a><a href="https://x.com/acme">b</a>`;
    expect(extractSocialProfiles(html)).toEqual(["https://x.com/acme"]);
  });
});

// ── Organization ──────────────────────────────────────────────────────────────

describe("Organization proposal", () => {
  it("prefers og:site_name and records provenance for every field", () => {
    const html = page(
      `<meta property="og:site_name" content="Acme Studio" />
       <meta name="description" content="An agency." />
       <link rel="apple-touch-icon" href="/icon.png" />`,
      `<a href="https://www.linkedin.com/company/acme">li</a>
       <a href="tel:+390212345">call</a>`,
    );
    const org = orgOf(html)!;
    expect(org.jsonLd.name).toBe("Acme Studio");
    expect(org.jsonLd.url).toBe("https://acme.example");
    expect(org.jsonLd.logo).toBe("https://acme.example/icon.png");
    expect(org.jsonLd.sameAs).toEqual(["https://www.linkedin.com/company/acme"]);
    expect(org.jsonLd.telephone).toBe("+390212345");

    // Every emitted field is traceable.
    const provenanced = new Set(org.provenance.map((p) => p.field));
    for (const field of Object.keys(org.jsonLd)) {
      if (field.startsWith("@")) continue;
      expect(provenanced.has(field)).toBe(true);
    }
    expect(org.provenance.find((p) => p.field === "name")?.source).toBe("og:site_name");
  });

  it("infers a name from <title> at medium confidence and warns", () => {
    const org = orgOf(page(`<title>Acme Studio | Digital agency in Milan</title>`))!;
    expect(org.jsonLd.name).toBe("Acme Studio");
    const prov = org.provenance.find((p) => p.field === "name")!;
    expect(prov.confidence).toBe("medium");
    expect(org.warnings.join(" ")).toMatch(/confirm the legal or trading name/);
  });

  it("splits on an entity-encoded dash (regression: pmicomunicare.com)", () => {
    const org = orgOf(page(
      `<title>Agenzia Web Marketing Milano &ndash; Siti Web, Social Media, SEO</title>`,
    ))!;
    expect(org.jsonLd.name).toBe("Agenzia Web Marketing Milano");
  });

  it("takes the first segment, not the shortest (regression: Prima Posizione)", () => {
    const org = orgOf(page(`<title>Prima Posizione | Agenzia SEO</title>`))!;
    expect(org.jsonLd.name).toBe("Prima Posizione");
  });

  it("does not split hyphenated brand names", () => {
    const org = orgOf(page(`<title>Prima-Posizione</title>`))!;
    expect(org.jsonLd.name).toBe("Prima-Posizione");
  });

  it("reports unsourceable fields as missing rather than inventing them", () => {
    const org = orgOf(page(`<title>Acme</title>`))!;
    expect(org.missing).toEqual(expect.arrayContaining(["logo", "description", "sameAs", "contactPoint"]));
    expect(org.jsonLd).not.toHaveProperty("description");
    expect(org.jsonLd).not.toHaveProperty("telephone");
  });

  it("warns when no social profiles exist, since sameAs is the entity signal", () => {
    const org = orgOf(page(`<title>Acme</title>`))!;
    expect(org.warnings.join(" ")).toMatch(/sameAs is the strongest entity-resolution signal/);
  });

  it("prefers a logo-tagged img over the apple-touch-icon", () => {
    const html = page(
      `<link rel="apple-touch-icon" href="/icon.png" />`,
      `<img src="/brand.svg" alt="Acme logo" />`,
    );
    const org = orgOf(html)!;
    expect(org.jsonLd.logo).toBe("https://acme.example/brand.svg");
    expect(org.provenance.find((p) => p.field === "logo")?.confidence).toBe("high");
  });
});

// ── augment, never duplicate ──────────────────────────────────────────────────

describe("existing schema", () => {
  it("does not propose a second Organization when one exists", () => {
    const result = proposeSchema(page(ldJson({ "@type": "Organization", name: "Acme" })), URL_);
    expect(result.proposals.find((p) => p.type === "Organization")).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/not proposing another Organization/);
  });

  it("treats LocalBusiness as satisfying the entity requirement", () => {
    const result = proposeSchema(page(ldJson({ "@type": "LocalBusiness" })), URL_);
    expect(result.proposals.find((p) => p.type === "Organization")).toBeUndefined();
  });

  it("still proposes Organization when only unrelated types are present", () => {
    const result = proposeSchema(page(ldJson({ "@type": "BreadcrumbList" })), URL_);
    expect(result.proposals.find((p) => p.type === "Organization")).toBeDefined();
    expect(result.existingTypes).toEqual(["BreadcrumbList"]);
  });

  it("sees through @graph nesting when deciding what already exists", () => {
    const html = page(ldJson({ "@graph": [{ "@type": "WebSite" }, { "@type": "Organization" }] }));
    expect(proposeSchema(html, URL_).proposals.find((p) => p.type === "Organization")).toBeUndefined();
  });
});

// ── FAQ ───────────────────────────────────────────────────────────────────────

describe("FAQ extraction", () => {
  const details = (q: string, a: string) =>
    `<details><summary>${q}</summary><p>${a}</p></details>`;

  it("extracts details/summary pairs", () => {
    const html = page("", details("What do you do?", "We build websites for clients in Milan.") +
      details("How much?", "Retainers start at one thousand euro per month."));
    const pairs = extractFaqPairs(html);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({
      question: "What do you do?",
      answer: "We build websites for clients in Milan.",
    });
  });

  it("extracts heading-question followed by prose", () => {
    const html = page("", `
      <h2>What is GEO?</h2><p>Generative engine optimisation, the practice of being cited.</p>
      <h2>Is it different from SEO?</h2><p>It overlaps heavily but the surfaces differ.</p>`);
    expect(extractFaqPairs(html)).toHaveLength(2);
  });

  it("ignores headings that do not ask a question", () => {
    const html = page("", `<h2>Our services</h2><p>We do many useful things for our clients.</p>`);
    expect(extractFaqPairs(html)).toEqual([]);
  });

  it("requires two pairs before proposing FAQPage", () => {
    const html = page("", details("Only one question?", "And only one answer, which is not an FAQ."));
    const result = proposeSchema(html, URL_);
    expect(result.proposals.find((p) => p.type === "FAQPage")).toBeUndefined();
    expect(result.notes.join(" ")).toMatch(/no FAQ content found/);
  });

  it("builds valid FAQPage markup from real page content", () => {
    const html = page("", details("What do you do?", "We build websites for clients in Milan.") +
      details("How much?", "Retainers start at one thousand euro per month."));
    const faq = proposeSchema(html, URL_).proposals.find((p) => p.type === "FAQPage")!;
    const entities = faq.jsonLd.mainEntity as Record<string, unknown>[];
    expect(entities).toHaveLength(2);
    expect(entities[0]["@type"]).toBe("Question");
    expect((entities[0].acceptedAnswer as Record<string, unknown>).text)
      .toBe("We build websites for clients in Milan.");
    expect(faq.warnings.join(" ")).toMatch(/stay in sync with the visible page/);
  });
});

// ── Product ───────────────────────────────────────────────────────────────────

describe("Product proposal", () => {
  it("emits a Product with an Offer when price meta is present", () => {
    const html = page(`
      <meta property="og:type" content="product" />
      <meta property="og:title" content="Trail Shoe" />
      <meta property="product:price:amount" content="129.00" />
      <meta property="product:price:currency" content="EUR" />
      <meta property="og:image" content="/shoe.jpg" />`);
    const product = proposeSchema(html, "https://shop.example/p/shoe").proposals
      .find((p) => p.type === "Product")!;
    expect(product.jsonLd.name).toBe("Trail Shoe");
    expect(product.jsonLd.offers).toMatchObject({ price: "129.00", priceCurrency: "EUR" });
    expect(product.jsonLd.image).toBe("https://shop.example/shoe.jpg");
    expect(product.missing).not.toContain("offers");
  });

  it("does not invent a Product on a page with no commerce signal", () => {
    const html = page(`<meta property="og:title" content="About us" />`);
    expect(proposeSchema(html, URL_).proposals.find((p) => p.type === "Product")).toBeUndefined();
  });

  it("warns when a product has no price", () => {
    const html = page(`
      <meta property="og:type" content="product" />
      <meta property="og:title" content="Trail Shoe" />`);
    const product = proposeSchema(html, "https://shop.example/p/shoe").proposals
      .find((p) => p.type === "Product")!;
    expect(product.missing).toContain("offers");
    expect(product.warnings.join(" ")).toMatch(/may not be eligible for rich results/);
  });
});

// ── rendering ─────────────────────────────────────────────────────────────────

describe("renderJsonLd", () => {
  it("produces a valid, parseable script tag", () => {
    const org = orgOf(page(`<meta property="og:site_name" content="Acme" />`))!;
    const rendered = renderJsonLd(org);
    expect(rendered.startsWith('<script type="application/ld+json">')).toBe(true);
    const body = rendered.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    const parsed = JSON.parse(body);
    expect(parsed["@context"]).toBe("https://schema.org");
    expect(parsed["@type"]).toBe("Organization");
  });
});

// ── name sourcing (measured against 10 live agency sites) ─────────────────────

describe("company name sourcing", () => {
  const withDomain = (html: string, url = "https://genesi.it/") =>
    proposeSchema(html, url).proposals.find((p) => p.type === "Organization")!;

  it("extracts the name from a footer copyright line", () => {
    expect(extractCopyrightName("<p>Copyright &copy; 1996-2026 Genesi.IT S.r.l. - Tutti i diritti riservati</p>"))
      .toBe("Genesi.IT S.r.l.");
    expect(extractCopyrightName("<span>&copy; 2026&nbsp;Netprofiler</span>")).toBe("Netprofiler");
  });

  it("ignores a stray 'Copyright section' comment", () => {
    expect(extractCopyrightName("<div>Copyright section Start Here</div>")).toBeUndefined();
  });

  it("prefers the copyright line over a keyword-stuffed title (regression: genesi.it)", () => {
    const org = withDomain(page(
      `<title>Realizzazione siti web | Genesi</title>`,
      `<footer>Copyright &copy; 1996-2026 Genesi.IT S.r.l. - Tutti i diritti riservati</footer>`,
    ));
    expect(org.jsonLd.name).toBe("Genesi.IT S.r.l.");
    expect(org.provenance.find((p) => p.field === "name")?.source).toBe("footer copyright line");
  });

  it("og:site_name still outranks the copyright line", () => {
    const org = withDomain(page(
      `<meta property="og:site_name" content="Genesi" /><title>Realizzazione siti web</title>`,
      `<footer>&copy; 2026 Genesi.IT S.r.l.</footer>`,
    ));
    expect(org.jsonLd.name).toBe("Genesi");
  });

  it("picks the title segment that matches the domain (regression: albertopozzi.com)", () => {
    const org = withDomain(
      page(`<title>Alberto Pozzi, Web Manager, Consulente Digitale progetti Web</title>`),
      "https://albertopozzi.com/",
    );
    expect(org.jsonLd.name).toBe("Alberto Pozzi");
  });

  it("flags an unverifiable name instead of dressing it as confident (regression: datodigitale.it)", () => {
    const org = withDomain(
      page(`<title>Agenzia Web Verona | Consulenza</title>`),
      "https://datodigitale.it/",
    );
    expect(org.provenance.find((p) => p.field === "name")?.source).toContain("UNVERIFIED");
    expect(org.missing.some((m) => m.startsWith("name (confirm"))).toBe(true);
    expect(org.warnings.join(" ")).toMatch(/very likely the tagline/);
  });

  it("nameMatchesDomain rejects keyword phrases and accepts real brands", () => {
    expect(nameMatchesDomain("Genesi.IT S.r.l.", "genesi.it")).toBe(true);
    expect(nameMatchesDomain("Netprofiler", "www.netprofiler.nl")).toBe(true);
    expect(nameMatchesDomain("Realizzazione siti web", "genesi.it")).toBe(false);
    expect(nameMatchesDomain("OmniSearch", "netprofiler.nl")).toBe(false);
  });
});

describe("copyright extraction boundaries (live regressions)", () => {
  it("stops at following link text (netprofiler.nl)", () => {
    expect(extractCopyrightName("<footer>&copy; 2026&nbsp;Netprofiler</footer><a>Terms and conditions</a>"))
      .toBe("Netprofiler");
  });

  it("strips a trailing registered mark (pmicomunicare.com)", () => {
    expect(extractCopyrightName("<footer>&copy; 2026 Pmicomunicare.com &reg;</footer>"))
      .toBe("Pmicomunicare.com");
  });

  it("keeps the period in a legal abbreviation", () => {
    expect(extractCopyrightName("<p>Copyright &copy; 2026 Genesi.IT S.r.l. - Tutti i diritti riservati</p>"))
      .toBe("Genesi.IT S.r.l.");
  });

  it("rejects a runaway capture rather than emitting a sentence", () => {
    expect(extractCopyrightName(
      "<footer>&copy; 2026 we are a full service digital agency working across many markets</footer>",
    )).toBeUndefined();
  });

  it("stops before a VAT number", () => {
    expect(extractCopyrightName("<footer>&copy; 2026 Acme Studio P.IVA 01234567890</footer>"))
      .toBe("Acme Studio");
  });
});

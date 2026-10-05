import { describe, expect, it } from "vitest";
import { aboutTerm, certainPageKind, classifyResult, NEEDS_PAGE_MIN_PAGES, namedIn, readResultsPage, rivalNamed, unwrapUrl, type JudgeKind } from "../results-page";
import { parseVerdicts } from "../buyer-fit";

const page = (term: string, rows: Array<[string, string, string?]>) =>
  readResultsPage(rows.map(([url, title, description], i) => ({ url, title, description: description ?? "", rank: i + 1 })), { term });

describe("what a result is", () => {
  it("reads articles from their paths, titles and dated snippets", () => {
    expect(classifyResult({ url: "https://garage.test/blog/why-brakes-squeal", title: "Why do brakes squeal?" })).toBe("editorial");
    expect(classifyResult({ url: "https://site.test/brake-noise", title: "Brake noise", description: "Mar 3, 2026 — Most squeals come from" })).toBe("editorial");
    expect(classifyResult({ url: "https://site.test/how-to-bleed-brakes-at-home-safely", title: "Bleeding brakes" })).toBe("editorial");
  });
  it("reads a business's own pages as service pages", () => {
    expect(classifyResult({ url: "https://garage.test/", title: "Northside Garage" })).toBe("commercial");
    expect(classifyResult({ url: "https://garage.test/services/brakes/", title: "Brake repair" })).toBe("commercial");
    expect(classifyResult({ url: "https://garage.test/brake-repair-pricing", title: "Brake repair prices" })).toBe("commercial");
  });
  it("sets listings, discussion and tools apart", () => {
    expect(classifyResult({ url: "https://www.yelp.com/search?find_desc=garage", title: "Top 10 garages" })).toBe("directory");
    expect(classifyResult({ url: "https://www.reddit.com/r/cars/comments/1/brakes", title: "Squealing brakes?" })).toBe("discussion");
    expect(classifyResult({ url: "https://apps.apple.com/app/brakes", title: "Brake log" })).toBe("utility");
  });
  it("reads a result shown through the translation proxy as the page it translates", () => {
    const proxied = "https://translate.google.com/translate?u=https://vendor.test/blog/top-10-garage-apps&hl=tr";
    expect(unwrapUrl(proxied)).toBe("https://vendor.test/blog/top-10-garage-apps");
    expect(classifyResult({ url: proxied, title: "Top 10 garage apps" })).toBe("editorial");
  });
  it("knows a result that is not about the phrase", () => {
    expect(aboutTerm({ url: "https://forum.test/t/1", title: "Weekend football scores" }, "acmegarage alternatives")).toBe(false);
    expect(aboutTerm({ url: "https://site.test/brake-noise", title: "Why brakes squeal" }, "squealing brakes")).toBe(true);
  });
});

describe("what a results page is", () => {
  it("is editorial when articles hold it", () => {
    const out = page("squealing brakes", [
      ["https://a.test/blog/brakes-squeal", "Why do brakes squeal?"],
      ["https://b.test/guides/brake-noise", "Brake noise: a guide"],
      ["https://garage.test/services/brakes", "Brake repair"],
    ]);
    expect(out.type).toBe("editorial");
    expect(out.editorialUrls).toEqual(["https://a.test/blog/brakes-squeal", "https://b.test/guides/brake-noise"]);
  });
  it("wants a landing page when providers' pages hold it", () => {
    const out = page("brake repair", [
      ["https://one.test/", "One Garage | Brake repair"],
      ["https://two.test/services/brake-repair", "Brake repair"],
      ["https://three.test/brakes", "Brakes"],
      ["https://a.test/blog/brake-repair-cost", "How much does brake repair cost?"],
    ]);
    expect(out.type).toBe("service");
    expect(out.summary).toContain("3 providers' own pages");
  });
  it("is one business's page when its own site holds it", () => {
    const out = page("acme garage", [
      ["https://acmegarage.test/", "Acme Garage"],
      ["https://acmegarage.test/contact", "Contact Acme Garage"],
      ["https://acmegarage.test/team", "Our team"],
      ["https://www.yelp.com/biz/acme-garage", "Acme Garage - Yelp"],
    ]);
    expect(out).toMatchObject({ type: "navigational", owner: "acmegarage.test" });
  });
  it("is nobody's page when the results are about other things", () => {
    const out = page("acmegarage alternatives", [
      ["https://forum.test/t/1", "Weekend football scores"],
      ["https://news.test/blog/tariffs", "Tariffs explained"],
      ["https://shop.test/", "Garden furniture"],
    ]);
    expect(out.type).toBe("other");
  });
  it("counts forum and video answers as an informational page an article would win", () => {
    const out = page("squealing brakes", [
      ["https://a.test/blog/brakes-squeal", "Why do brakes squeal?"],
      ["https://www.reddit.com/r/cars/comments/1/squealing_brakes", "Squealing brakes after rain"],
      ["https://www.youtube.com/watch?v=1", "Fix squealing brakes"],
    ]);
    expect(out.type).toBe("editorial");
  });
});

describe("the buyer test's stages", () => {
  it("keeps the stages the business serves and marks a problem search top of funnel", () => {
    const out = parseVerdicts(JSON.stringify([
      { t: "why do brakes squeal", s: "problem", r: "driver with noisy brakes" },
      { t: "brake repair near me", s: "hiring", r: "ready to book" },
      { t: "acme garage", s: "navigation", r: "another garage" },
      { t: "mechanic apprenticeship", s: "practitioner", r: "learning the trade" },
    ]), ["why do brakes squeal", "brake repair near me", "acme garage", "mechanic apprenticeship"]);
    expect(out.get("why do brakes squeal")).toMatchObject({ keep: true, funnel: "audience" });
    expect(out.get("brake repair near me")).toMatchObject({ keep: true, funnel: "buyer" });
    expect(out.get("acme garage")).toMatchObject({ keep: false });
    expect(out.get("mechanic apprenticeship")?.reason).toContain("learning the trade");
  });
  it("gives no decision for a stage it does not know", () => {
    expect(parseVerdicts(JSON.stringify([{ t: "brakes", s: "maybe", r: "?" }]), ["brakes"]).size).toBe(0);
  });
  it("reads the answer after reasoning written into the reply", () => {
    const raw = `<think>\n1. "brakes" - [problem]\n</think>\n[{"t":"brakes","s":"problem","r":"driver"}]`;
    expect(parseVerdicts(raw, ["brakes"]).get("brakes")).toMatchObject({ keep: true });
  });
});

describe("a result about the phrase, on word boundaries", () => {
  it("does not read a compound name into two words written apart by punctuation", () => {
    expect(aboutTerm({ url: "https://research.test/paper", title: "A Field (CRM) survey for farms" }, "fieldcrm alternatives")).toBe(false);
    expect(aboutTerm({ url: "https://fieldcrm.test/", title: "Home" }, "fieldcrm alternatives")).toBe(true);
    expect(aboutTerm({ url: "https://a.test/", title: "Field CRM review" }, "fieldcrm alternatives")).toBe(true);
  });
  it("still finds an inflection, and a short word only at the start of a word", () => {
    expect(aboutTerm({ url: "https://a.test/", title: "Why brakes squeal" }, "squealing")).toBe(true);
    expect(aboutTerm({ url: "https://a.test/", title: "Invoices for freelancers" }, "invoicing")).toBe(true);
    expect(aboutTerm({ url: "https://a.test/", title: "Best CRMs for startups" }, "crm")).toBe(true);
    expect(aboutTerm({ url: "https://a.test/", title: "Microcrm news" }, "crm")).toBe(false);
  });
});

describe("the page type from the judge's kinds", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://s${i}.test/caldaie-condensazione-guida`, title: "Caldaie a condensazione", rank: i + 1 }));
  it("decides every result from the kinds when one is given per result, and says so", () => {
    const kinds = ["commercial", "commercial", "commercial", "commercial", "commercial", "commercial", "editorial", "editorial", "editorial", "editorial"] as const;
    const out = readResultsPage(rows(10), { term: "caldaie condensazione", kinds: [...kinds] });
    expect(out).toMatchObject({ type: "service", basis: "judge" });
    expect(readResultsPage(rows(10), { term: "caldaie condensazione" }).basis).toBe("urls");
  });
  it("needs a page when more than half are business-built, and is mixed when articles hold their own", () => {
    const k = (c: number, e: number, o: number) => [...Array(c).fill("commercial"), ...Array(e).fill("editorial"), ...Array(o).fill("discussion")];
    expect(readResultsPage(rows(10), { kinds: k(6, 4, 0) }).type).toBe("service");
    expect(readResultsPage(rows(10), { kinds: k(5, 5, 0) }).type).toBe("mixed");
    expect(readResultsPage(rows(10), { kinds: k(2, 6, 2) }).type).toBe("editorial");
    expect(readResultsPage(rows(10), { kinds: k(2, 1, 7) }).type).toBe("editorial");
    expect(readResultsPage(rows(10), { kinds: [...Array(6).fill("offtopic"), ...Array(4).fill("editorial")] }).type).toBe("other");
    expect(readResultsPage(rows(10), { kinds: [...Array(6).fill("utility"), ...Array(4).fill("editorial")] }).type).toBe("other");
  });
});

describe("a phrase naming a business", () => {
  // Rivals whose domains are generic words run together: a service plus a
  // city, a trade word. Their words are the site's own core searches.
  const named = ["repairdenver.test", "denverrepair.test", "brakes.test", "https://www.acme-garage.test/"];
  it("is a search for the business only when it is the name plus navigation words", () => {
    expect(namedIn("acme garage", named)).toBe("acme garage");
    expect(namedIn("acme garage opening hours", named)).toBe("acme garage");
    expect(namedIn("brakes login", named)).toBe("brakes");
  });
  it("leaves generic words to the judge, however a rival's domain spells them", () => {
    for (const term of ["repair denver", "denver repair", "denver repair for brake noise", "brake repair cost", "brakes squealing when stopping"]) {
      expect(namedIn(term, named), term).toBeNull();
    }
  });
  it("never calls a question about a business a search for it", () => {
    expect(namedIn("acme garage alternatives", named)).toBeNull();
    expect(namedIn("acme garage reviews", named)).toBeNull();
  });
  it("finds a rival's name as whole words, whatever else the phrase says", () => {
    expect(rivalNamed("acme garage alternatives", named)).toBe("acme garage");
    expect(rivalNamed("repair denver", named)).toBeNull();
    expect(rivalNamed("repairdenver alternative", named)).toBe("repairdenver");
  });
  it("does not read a page as navigational because a rival's domain holds the phrase's letters", () => {
    const out = readResultsPage([
      { url: "https://a.test/blog/repair-denver-guide", title: "Repair in Denver: a guide" },
      { url: "https://b.test/blog/denver-repair-costs", title: "Denver repair costs explained" },
      { url: "https://c.test/services/repair", title: "Repair | C" },
    ], { term: "repair denver", named });
    expect(out.type).not.toBe("navigational");
  });
});

describe("why a page is 'other'", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://r${i}.test/p`, title: `Result ${i}` }));
  it("says which rule said so, so only a page short of articles is a floor candidate", () => {
    expect(readResultsPage(rows(10), { kinds: [...Array(6).fill("offtopic"), ...Array(4).fill("editorial")] }).why).toBe("offtopic");
    expect(readResultsPage(rows(10), { kinds: [...Array(6).fill("utility"), ...Array(4).fill("editorial")] }).why).toBe("utility");
    expect(readResultsPage(rows(4), { kinds: ["editorial", "utility", "commercial", "offtopic"] }).why).toBe("few_articles");
  });
  it("checks the judge's articles against the phrase's words", () => {
    const out = readResultsPage([
      { url: "https://a.test/blog/zen-gardens", title: "Zen gardens" },
      { url: "https://b.test/blog/what-is-crm", title: "What is a CRM?" },
      { url: "https://c.test/blog/field-guide", title: "A field guide" },
      { url: "https://zentrocrm.test/", title: "Zentrocrm" },
    ], { term: "zentrocrm alternatives", kinds: ["editorial", "editorial", "editorial", "commercial"] });
    expect(out.counts.offtopic).toBe(3);
    expect(out).toMatchObject({ type: "other", why: "offtopic" });
  });
});

describe("what each result page is, read from the page, never from its host", () => {
  const kind = (url: string, title = "", description = "", domain?: string) => certainPageKind({ url, title, description }, { domain });
  it("reads a provider's blog post as an article and its service page as its own page, on the same host", () => {
    expect(kind("https://acme-garage.example/blog/why-brakes-squeal/", "Why do brakes squeal?")).toBe("article");
    expect(kind("https://acme-garage.example/2025/03/brake-noise/", "Brake noise")).toBe("article");
    expect(kind("https://acme-garage.example/services/brake-repair/", "Brake repair")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/book-online", "Book online")).toBe("service_or_local");
  });
  it("reads the home page (or a language prefix alone) as a provider's own page", () => {
    expect(kind("https://acme-garage.example/", "Acme Garage")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/en/", "Acme Garage")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/?ref=maps", "Acme Garage")).toBe("service_or_local");
  });
  it("reads listings, shops, portals, discussion and the site's own pages by what they are", () => {
    expect(kind("https://www.yelp.com/biz/acme-garage", "Acme Garage")).toBe("directory");
    expect(kind("https://acme-finder.example/find-a-mechanic/", "Find a mechanic")).toBe("directory");
    expect(kind("https://www.instagram.com/acme_garage/", "Acme Garage")).toBe("directory");
    expect(kind("https://acme-parts.example/shop/brake-pads", "Brake pads")).toBe("product");
    expect(kind("https://apps.apple.com/app/brakes", "Brake log")).toBe("portal");
    expect(kind("https://www.reddit.com/r/cars/comments/1/brakes", "Squealing brakes?")).toBe("discussion");
    expect(kind("https://www.acme-own.example/brakes/", "Brakes", "", "acme-own.example")).toBe("own");
  });
  it("reads a written list of providers as an article, whoever publishes it", () => {
    expect(kind("https://acme-agency.example/best-garages-denver", "Top 10 Garages in Denver")).toBe("article");
    expect(kind("https://acme-agency.example/garages", "Denver 10+ Brake Repair Garages")).toBe("article");
    expect(kind("https://acme-agency.example/fren-tamir-firmalari", "En İyi Fren Tamir Firmaları")).toBe("article");
  });
  it("reads a phone number or a price list as a provider's page, and leaves the rest to the judge", () => {
    expect(kind("https://acme-garage.example/brakes", "Brakes", "(303) 555-0101 · Open today")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/brake-repair-prices", "Brake repair")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/brake-services", "Brakes")).toBe("service_or_local");
    expect(kind("https://acme-garage.example/brake-repair-guide", "Brake repair: what it involves")).toBeNull();
    // A place in a title is the judge's call: "in" and a capitalised word is also title case.
    expect(kind("https://acme-garage.example/brake-repair-denver", "Brake Repair in Denver")).toBeNull();
  });
  it("never overrules the judge on a signal that is only likely", () => {
    const titles: Array<[string, string]> = [
      ["https://acme-mag.example/auto/bremsen", "Bremsbeläge wechseln in Eigenregie: So geht es"],
      ["https://acme-mag.example/bremsen-pruefen", "Bremsen prüfen in Schritten"],
      ["https://acme-cars.example/brake-fade", "Brake Fade in Mountain Driving"],
      ["https://acme-cars.example/brake-noise", "Brake Noise in Cold Weather | Acme Cars"],
      // An article's slug ending in a service word, under a section that is not a service section.
      ["https://acme-cars.example/problems/brake-pad-treatments", "Brake Pad Coatings That Work"],
      ["https://acme-cars.example/why-pads-matter-in-brake-service", "Why Pads Matter in Brake Service"],
      // A question or an article title wins over a service section or a price slug.
      ["https://acme-agency.example/about/what-is-seo", "What Is SEO? A Beginner's Guide"],
      ["https://acme-garage.example/riparazione-freni-prezzi", "Riparazione freni: quali prezzi?"],
      // A document filed under a service section is not a service page.
      ["https://acme-garage.example/services/brakes/fluid-data-sheet.pdf", "Brake Fluid Data Sheet"],
    ];
    for (const [url, title] of titles) expect(kind(url, title), title).toBeNull();
  });
  it("reads an article section before a shop's host, and a shop's article-titled page as the judge's call", () => {
    expect(kind("https://www.ebay.com/seller-blog/how-to-price-brake-pads", "Pricing brake pads")).toBe("article");
    expect(kind("https://www.ebay.com/glossary/brake-pad", "What is a brake pad?")).toBeNull();
    expect(kind("https://www.ebay.com/itm/brake-pads-123", "Brake pads front set")).toBe("product");
  });
});

describe("the page-type rule", () => {
  const rows = (urls: string[]) => urls.map((url, i) => ({ url, title: "Brake repair", description: "", rank: i + 1 }));
  const service = (i: number) => `https://garage${i}.example/services/brake-repair`;
  const post = (i: number) => `https://garage${i}.example/blog/brake-repair-explained`;
  it(`needs a page at ${NEEDS_PAGE_MIN_PAGES} providers' pages, whatever the judge called them`, () => {
    const urls = [...Array.from({ length: NEEDS_PAGE_MIN_PAGES }, (_, i) => service(i)), ...Array.from({ length: 10 - NEEDS_PAGE_MIN_PAGES }, (_, i) => post(i + 20))];
    const judged = Array(10).fill("article") as JudgeKind[];
    const out = readResultsPage(rows(urls), { term: "brake repair", judged });
    expect(out).toMatchObject({ type: "service", rule: "needs_page", decidedByCode: NEEDS_PAGE_MIN_PAGES });
    expect(out.pages.service_or_local).toBe(NEEDS_PAGE_MIN_PAGES);
    // Read the old way (the judge's word final), the same page was an article search.
    expect(readResultsPage(rows(urls), { term: "brake repair", judged, pageRule: false }).type).toBe("editorial");
  });
  it("keeps an even split of articles and providers an article search", () => {
    const urls = [...[0, 1, 2, 3, 4].map(service), ...[5, 6, 7, 8, 9].map(post)];
    const out = readResultsPage(rows(urls), { term: "brake repair", judged: Array(10).fill("article") as JudgeKind[] });
    expect(out.rule).toBeUndefined();
    expect(out.type).toBe("mixed");
  });
  it("lets the judge's off-topic stand over a page's own kind", () => {
    const out = readResultsPage(rows([service(0), service(1), post(2)]), { term: "brake repair", judged: ["offtopic", "service", "article"] });
    expect(out.results.map((r) => r.page)).toEqual(["offtopic", "service_or_local", "article"]);
  });
  it("reads a provider holding three results of a local search with the rule, and a search naming it as navigational", () => {
    const local = rows([
      "https://acme-garage.example/denver/", "https://acme-garage.example/aurora/", "https://acme-garage.example/boulder/",
      "https://www.yelp.com/biz/one", "https://www.yelp.com/biz/two", "https://acme-list.example/listing/three", "https://acme-list.example/listing/four",
      "https://garage9.example/blog/brakes-explained",
    ]);
    const judged: JudgeKind[] = ["local", "local", "local", "directory", "directory", "directory", "directory", "article"];
    expect(readResultsPage(local, { term: "brake repair denver", judged })).toMatchObject({ type: "local", rule: "needs_page" });
    expect(readResultsPage(local, { term: "acme garage", judged }).type).toBe("navigational");
  });
  it("needs a page when nine providers' pages hold a search the judge read as articles", () => {
    const providers = [
      "https://acme-brakes.example/", "https://acme-garage1.example/services/brake-repair", "https://acme-finder.example/find-a-mechanic/",
      "https://acme-garage2.example/book-online", "https://acme-garage3.example/en/", "https://acme-garage4.example/contact",
      "https://acme-garage5.example/locations/downtown", "https://acme-garage6.example/", "https://www.instagram.com/acme_garage/",
    ];
    const organic = [...providers, "https://acme-cars.example/blog/brake-repair-explained"].map((url, i) => ({ url, title: "Brake specialist", rank: i + 1 }));
    const judged = Array(10).fill("article") as JudgeKind[];
    expect(readResultsPage(organic, { term: "brake specialist", judged, domain: "acme-own.example" })).toMatchObject({ type: "service", rule: "needs_page" });
    expect(readResultsPage(organic, { term: "brake specialist", judged, pageRule: false }).type).toBe("editorial");
  });
  it("keeps a home page the judge read as a forum or a listing what the judge said", () => {
    const organic = [{ url: "https://acme-community.example/", title: "Acme Car Owners Forum", rank: 1 }, { url: "https://acme-garage.example/", title: "Acme Garage", rank: 2 }];
    const out = readResultsPage(organic, { term: "car owners", judged: ["forum", "article"] });
    expect(out.results.map((r) => r.page)).toEqual(["discussion", "service_or_local"]);
  });
  it("keeps five articles and five providers an article search when one article's slug ends in a service word", () => {
    const articles = ["what-drivers-get-from-a-brake-service", "brake-pad-wear", "why-brakes-squeal", "brake-fluid-colour", "brake-disc-scoring"]
      .map((slug, i) => ({ url: `https://acme-cars${i}.example/${slug}/`, title: i === 0 ? "Brake Service for Drivers" : "Brake Wear Explained" }));
    const providers = [1, 2, 3, 4, 5].map((i) => ({ url: `https://acme-garage${i}.example/brakes`, title: `Brakes | Acme Garage ${i}` }));
    const organic = [...articles, ...providers].map((r, i) => ({ ...r, rank: i + 1 }));
    const judged = [...Array(5).fill("article"), ...Array(5).fill("service")] as JudgeKind[];
    expect(readResultsPage(organic, { term: "brake service", judged, domain: "acme-own.example" })).toMatchObject({ type: "mixed" });
  });
  it("reads a generic search one provider owns the exact-match domain of by its page, not as a search for that provider", () => {
    const organic = [
      "https://www.roofrepair-acme.example/", "https://www.roofrepair-acme.example/about-us", "https://www.roofrepair-acme.example/contact",
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => `https://acme-roofer${i}.example/`),
    ].map((url, i) => ({ url, title: "Roof repair", rank: i + 1 }));
    const judged = Array(10).fill("service") as JudgeKind[];
    expect(readResultsPage(organic, { term: "roof repair", judged })).toMatchObject({ type: "service", rule: "needs_page" });
    // The phrase carrying the whole name is still a search for the business.
    expect(readResultsPage(organic, { term: "roof repair acme", judged }).type).toBe("navigational");
  });
});

import { describe, it, expect } from "vitest";
import { buildTopicalProfile, scoreRelevance } from "../topical-profile";
import type { CrawlResult } from "@/lib/audit/crawler";

const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://supalabs.co/",
  status: 200,
  title: "",
  metaDescription: "",
  h1: [],
  h2: [],
  images: [],
  links: [],
  loadTimeMs: 0,
  ...over,
});

/** Modelled on the real supalabs.co crawl. */
const SUPALABS = buildTopicalProfile(
  "supalabs.co",
  [
    page({
      title: "AI-Native Operations for European Companies | SUPALABS",
      metaDescription:
        "We embed with European companies and rebuild how the work actually runs. First workflow in production in 6 weeks, owned by your team.",
      h1: ["Stop adding AI. Start operating differently."],
      h2: ["Operators, not advice.", "We serve businesses across industries"],
    }),
    page({ title: "RAG delivery sprint | SUPALABS", h1: ["Retrieval audit and delivery"] }),
  ],
  "2026-08-20T00:00:00.000Z",
);

describe("buildTopicalProfile", () => {
  it("captures the vocabulary the business actually uses", () => {
    for (const term of ["operations", "european", "workflow", "supalabs"]) {
      expect(SUPALABS.terms[term]).toBeGreaterThan(0);
    }
  });

  it("weights titles and h1s above subheadings", () => {
    const p = buildTopicalProfile("x.com", [
      page({ title: "widgets", h2: ["gadgets"] }),
    ]);
    expect(p.terms.widgets).toBeGreaterThan(p.terms.gadgets);
  });

  it("includes the domain name, which copy often omits", () => {
    expect(SUPALABS.terms.supalabs).toBeGreaterThan(0);
  });

  it("drops boilerplate statistically, with no stopword list", () => {
    // Every page repeats the nav and the tagline; only the product words vary.
    // Nothing here is hardcoded, so the same mechanism works in any language.
    const nav = "Home About Contact Privacy";
    const p = buildTopicalProfile(
      "x.com",
      [
        page({ title: `${nav} Hydraulic pumps`, h1: [nav], h2: [nav, "Hydraulic pumps"] }),
        page({ title: `${nav} Valve seals`, h1: [nav], h2: [nav, "Valve seals"] }),
        page({ title: `${nav} Gasket kits`, h1: [nav], h2: [nav, "Gasket kits"] }),
      ],
    );
    for (const w of ["home", "about", "contact", "privacy"]) {
      expect(p.terms[w]).toBeUndefined();
    }
    expect(p.terms.hydraulic).toBeGreaterThan(0);
    expect(p.terms.valve).toBeGreaterThan(0);
  });

  it("drops boilerplate in a non-English site the same way", () => {
    // The reason for going statistical: a curated English stopword list would
    // have produced garbage profiles for 35 of the 36 supported locales.
    const nav = "Inicio Nosotros Contacto Privacidad";
    const p = buildTopicalProfile(
      "x.es",
      [
        page({ title: `${nav} Bombas hidraulicas`, h1: [nav], h2: [nav, "Bombas hidraulicas"] }),
        page({ title: `${nav} Juntas`, h1: [nav], h2: [nav, "Juntas"] }),
        page({ title: `${nav} Valvulas`, h1: [nav], h2: [nav, "Valvulas"] }),
      ],
    );
    for (const w of ["inicio", "nosotros", "contacto", "privacidad"]) {
      expect(p.terms[w]).toBeUndefined();
    }
    expect(p.terms.bombas).toBeGreaterThan(0);
  });

  it("decodes HTML entities rather than blocklisting their fragments", () => {
    // The crawler stores raw text, so "don&#x27;t" and "R&amp;D" tokenised to
    // "x27" and "amp", both of which ranked in a real site's top ten terms.
    const p = buildTopicalProfile("x.com", [
      page({ title: "Don&#x27;t guess &amp; hope", h1: ["R&amp;D services"] }),
    ]);
    expect(p.terms.x27).toBeUndefined();
    expect(p.terms.amp).toBeUndefined();
  });

  it("is deterministic for the same input", () => {
    const a = buildTopicalProfile("x.com", [page({ title: "alpha beta" })], "t");
    const b = buildTopicalProfile("x.com", [page({ title: "alpha beta" })], "t");
    expect(a).toEqual(b);
  });
});

describe("scoreRelevance", () => {
  it("rejects the keyword that caused this module to exist", () => {
    // A live autonomous run picked "ai book" for an AI operations consultancy
    // and generated "The AI Book Guide: Best Reads on Artificial Intelligence".
    const r = scoreRelevance("ai book", SUPALABS);
    expect(r.score).toBe(0);
    expect(r.unmatched).toContain("book");
    expect(r.reason).toContain("does not appear");
  });

  it("accepts the business's own positioning", () => {
    expect(scoreRelevance("ai native operations", SUPALABS).score).toBe(1);
  });

  it("accepts vocabulary from deeper pages, not just the homepage", () => {
    expect(scoreRelevance("rag delivery", SUPALABS).score).toBe(1);
  });

  it("rejects an unrelated industry", () => {
    expect(scoreRelevance("plumbing quotes", SUPALABS).score).toBe(0);
  });

  it("scores a partial match between the extremes", () => {
    const r = scoreRelevance("workflow plumbing", SUPALABS);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it("matches across simple plural and suffix variation", () => {
    // "companies" in the copy should satisfy "company". Asserted as a strong
    // match rather than exactly 1: a stem hit is scored by the matched term's
    // weight, so it lands just under a direct hit.
    expect(scoreRelevance("european company", SUPALABS).score).toBeGreaterThan(0.9);
  });

  it("stays neutral when there is no profile", () => {
    // Absence of evidence is not evidence of irrelevance: a workspace whose
    // crawl was blocked must not have every keyword suppressed.
    const r = scoreRelevance("anything at all", null);
    expect(r.score).toBe(1);
    expect(r.reason).toContain("no topical profile");
  });

  it("stays neutral for an empty profile", () => {
    const empty = buildTopicalProfile("x.com", [], "t");
    expect(scoreRelevance("anything", empty).score).toBe(1);
  });
});

describe("seedPhrasesFromPages", () => {
  it("seeds with the site's own phrases, not nav words or single tokens", async () => {
    const { seedPhrasesFromPages } = await import("../topical-profile");
    const seeds = seedPhrasesFromPages([
      { title: "AI-Driven Warehouse Orchestration Platform - Lully.ai", h1: ["Warehouse Orchestration"], h2: ["By the Numbers:", "Lully's Why:", "AI Driven Warehouse Orchestration", "Hear from your Peers + More", "Case Studies"] },
      { title: "Case Studies - Lully.ai", h1: ["Case Studies"], h2: ["Learn more", "Labor cost reduction at a 3PL"] },
    ], "www.lully.ai");
    expect(seeds[0]).toBe("warehouse orchestration");
    expect(seeds.join(" ")).not.toContain("case stud");
    expect(seeds.join(" ")).not.toContain("learn more");
    expect(seeds.every((s) => s.split(" ").length >= 2)).toBe(true);
  });
});

describe("domainTokens", () => {
  it("keeps the brand and drops www and the public suffix", async () => {
    const { domainTokens } = await import("../topical-profile");
    expect(domainTokens("www.lully.ai")).toEqual(["lully"]);
    expect(domainTokens("shop.acme-tools.co.uk")).toEqual(["shop", "acme", "tools"]);
    expect(domainTokens("https://altorank.co/")).toEqual(["altorank"]);
  });
});

describe("homepage signature", () => {
  it("keeps a positioning word that recurs in most headings", async () => {
    const { buildTopicalProfile } = await import("../topical-profile");
    const page = (title: string, h1: string[], h2: string[]) => ({ url: "https://x.co/", status: 200, title, metaDescription: "", h1, h2, images: [], links: [], loadTimeMs: 1 });
    const pages = [
      page("AI-Driven Warehouse Orchestration Platform", ["Warehouse Orchestration"], ["Warehouse ops are complex", "By the numbers"]),
      // Half the site says "warehouse" in its headings: common, not universal.
      ...Array.from({ length: 5 }, (_, i) => page(`Warehouse guide ${i}`, [`Warehouse topic ${i}`], ["Learn more"])),
      ...Array.from({ length: 5 }, (_, i) => page(`Article ${i}`, [`Topic ${i}`], ["Learn more"])),
    ];
    const prof = buildTopicalProfile("www.lully.ai", pages);
    expect("warehouse" in prof.terms).toBe(true);
    expect("orchestration" in prof.terms).toBe(true);
    expect("www" in prof.terms).toBe(false);
    expect("lully" in prof.terms).toBe(true);
  });
});

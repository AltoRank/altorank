import { describe, it, expect } from "vitest";
import { approvalBlocker, autoApprovalBlocker, entityClaimsIn, factCheckArticle, namesAnAssociation } from "../fact-check";
import { verifyCitedFigures, pageNamesEntity, type PageFetcher } from "@/lib/seo/citation-check";
import { resolveLocale, type SupportedLocale } from "@/lib/i18n/locale";

// A real signup's first article (2026-09-27, a physiotherapy clinic) named a
// national professional association as the regulator of physiotherapists.
// The regulator is the provincial college. The article had no figures, so the
// checker found nothing and said `clean`. Every name below is invented.

const en = resolveLocale("en") as SupportedLocale;

/** A readable page: long enough that the check treats its silence as meaning something. */
const page = (body: string) => `<html><body><main><p>${body}</p><p>${"Filler text about the profession. ".repeat(20)}</p></main></body></html>`;
const serve = (html: string): PageFetcher => async () => ({ status: 200, body: html });

describe("authority and coverage claims are claims", () => {
  it("flags an association named as the regulator, for review and never as a block", () => {
    const r = factCheckArticle(
      "<p>In Northland, the Northland Physiotherapy Association regulates physiotherapists and sets their standards.</p>",
    );
    expect(r.claims).toHaveLength(1);
    const c = r.claims[0];
    expect(c.kind).toBe("authority");
    expect(c.text).toBe("Northland Physiotherapy Association");
    expect(c.status).toBe("unsourced");
    expect(c.severity).toBe("medium");
    expect(c.note).toMatch(/association is usually a membership body, not the regulator/);
    expect(r.verdict).toBe("review");
    expect(approvalBlocker(r)).toBeNull();
    expect(autoApprovalBlocker(r)).toBeNull();
  });

  it("reads the passive form and keeps the acronym with the name", () => {
    const [claim] = entityClaimsIn(
      "Physiotherapists here are regulated by the College of Physiotherapists of Northland (CPN), not by any association.",
      en,
    );
    expect(claim).toEqual(expect.objectContaining({ kind: "authority", entity: "College of Physiotherapists of Northland (CPN)" }));
  });

  it("reads a coverage claim with and without a named insurer", () => {
    const named = factCheckArticle("<p>Acme Mutual covers up to ten visits of athletic therapy.</p>");
    expect(named.claims.find((c) => c.kind === "coverage")?.text).toBe("Acme Mutual");
    const generic = factCheckArticle("<p>Most extended health plans cover physiotherapy with a referral.</p>");
    const c = generic.claims.find((x) => x.kind === "coverage");
    expect(c).toBeDefined();
    expect(c!.figures).toEqual([]);
    expect(c!.status).toBe("unsourced");
  });

  it("does not read ordinary uses of the same verbs as claims", () => {
    for (const s of [
      "They registered with a click and started the same day.",
      "The guide covers the basics of recovery after a sprain.",
      "Our team covered the first session at no charge.",
    ]) {
      expect(entityClaimsIn(s, en), s).toEqual([]);
    }
  });

  it("marks a linked claim for verification, then checks the cited page names the body", async () => {
    const html =
      '<p>Physiotherapists are regulated by the College of Physiotherapists of Northland, ' +
      'as <a href="https://regulator.example/about">its register explains</a>.</p>';
    const before = factCheckArticle(html);
    expect(before.claims[0].status).toBe("needs_verification");
    expect(before.claims[0].sourceUrl).toBe("https://regulator.example/about");

    const named = await verifyCitedFigures(before, {
      fetcher: serve(page("The College of Physiotherapists of Northland keeps the public register.")),
    });
    expect(named.claims[0].status).toBe("verified");
    expect(named.claims[0].severity).toBe("low");

    const other = await verifyCitedFigures(before, {
      fetcher: serve(page("The Northland Physiotherapy Association welcomes new members.")),
    });
    expect(other.claims[0].status).toBe("unsupported");
    expect(other.claims[0].severity).toBe("medium");
    expect(other.verdict).toBe("review");
    expect(approvalBlocker(other)).toBeNull();
  });

  it("leaves an entity claim alone when the cited page cannot be read", async () => {
    const before = factCheckArticle(
      '<p>Visits are covered by Acme Mutual, <a href="https://insurer.example/plan">per the plan</a>.</p>',
    );
    const after = await verifyCitedFigures(before, { fetcher: async () => ({ status: 403, body: "" }) });
    expect(after.claims[0].status).toBe("needs_verification");
  });

  it("finds a body by its name or its acronym", () => {
    const text = "the cpn keeps the register of physiotherapists in northland.";
    expect(pageNamesEntity(text, "College of Physiotherapists of Northland (CPN)")).toBe(true);
    expect(pageNamesEntity(text, "Northland Physiotherapy Association")).toBe(false);
  });

  it("recognises an association in every supported language", () => {
    for (const name of ["Northland Physiotherapy Association", "Associazione Italiana Fisioterapisti", "Türk Fizyoterapistler Derneği", "Deutscher Verband für Physiotherapie", "Asociación Española de Fisioterapeutas"]) {
      expect(namesAnAssociation(name), name).toBe(true);
    }
    expect(namesAnAssociation("College of Physiotherapists of Northland")).toBe(false);
  });
});

describe("authority and coverage claims in each supported language", () => {
  const cases: Array<[string, string, "authority" | "coverage", string]> = [
    ["it", "Le prestazioni sono rimborsate dal Servizio Sanitario Nazionale in parte.", "coverage", "Servizio Sanitario Nazionale"],
    ["es", "La fisioterapia está regulada por el Consejo General de Fisioterapeutas en todo el país.", "authority", "Consejo General de Fisioterapeutas"],
    ["fr", "Les séances sont prises en charge par l'Assurance Maladie sur prescription.", "coverage", "Assurance Maladie"],
    ["de", "Die Behandlung wird von der Krankenkasse übernommen, wenn ein Rezept vorliegt.", "coverage", "Krankenkasse"],
    ["tr", "Türkiye'de fizyoterapistler Türk Fizyoterapistler Derneği tarafından düzenlenir.", "authority", "Türk Fizyoterapistler Derneği"],
  ];
  for (const [lang, sentence, kind, entity] of cases) {
    it(`${lang}: ${kind} (${entity})`, () => {
      const r = factCheckArticle(`<p>${sentence}</p>`, undefined, lang);
      const c = r.claims.find((x) => x.kind === kind);
      expect(c, JSON.stringify(r.claims)).toBeDefined();
      expect(c!.text).toBe(entity);
      expect(c!.severity).toBe("medium");
    });
  }
});

describe("a coverage claim is only read in a sentence about paying for something", () => {
  it("leaves the everyday verb alone", () => {
    for (const s of [
      "Acme Keyword Tool covers 25 billion keywords across 140 markets.",
      "The Northland Guide covers every stretch you need after a run.",
    ]) {
      expect(entityClaimsIn(s, en).filter((c) => c.kind === "coverage"), s).toEqual([]);
    }
    expect(entityClaimsIn("Acme Mutual covers athletic therapy visits under its extended health benefits.", en)[0]).toMatchObject({ kind: "coverage", entity: "Acme Mutual" });
  });
});

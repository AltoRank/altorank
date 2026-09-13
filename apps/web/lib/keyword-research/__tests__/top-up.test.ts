import { describe, it, expect } from "vitest";
import {
  harvestFromResearch,
  playbookCandidates,
  newCandidates,
  worthStoring,
  rankForStorage,
  TOP_UP_PLAYBOOKS,
} from "../top-up";
import type { TermMetrics } from "../metrics";
import { subjectVocabulary } from "@/lib/seo/topical-profile";

/**
 * qasimcode.com stopped on its fifth article: fifteen keywords still in `new`
 * and every one out of reach at authority 0. The pool was not empty, the
 * writable pool was, and discovery had run once at signup and never again.
 */

const PROFILE = {
  name: "Qasimcode",
  language: "English",
  country: "Global (English)",
  description:
    "Qasimcode builds appointment-based websites for medical and dental clinics, salons and trades, with online booking wired to the calendar they already use. Fixed price agreed upfront.",
  audiences: ["dental clinics", "salons", "speech therapy practices"],
  competitors: ["wix.com", "squarespace.com"],
};

const metric = (over: Partial<TermMetrics>): TermMetrics => ({
  term: "x",
  volume: 500,
  difficulty: 20,
  cpc: 1,
  intent: "commercial",
  ...over,
});

describe("harvestFromResearch — keywords we already paid for", () => {
  it("takes the related keywords stored on an article", () => {
    const terms = harvestFromResearch([
      { research: { relatedKeywords: [{ keyword: "salon booking website" }, { keyword: "dental website" }] } },
    ]);
    expect(terms).toEqual(["salon booking website", "dental website"]);
  });

  it("takes the People Also Ask questions too", () => {
    const terms = harvestFromResearch([
      { research: { peopleAlsoAsk: ["how much does a clinic website cost"] } },
    ]);
    expect(terms).toContain("how much does a clinic website cost");
  });

  it("reads across every article, because one article is thirty terms", () => {
    const terms = harvestFromResearch([
      { research: { relatedKeywords: [{ keyword: "a" }] } },
      { research: { relatedKeywords: [{ keyword: "b" }] } },
    ]);
    expect(terms).toEqual(["a", "b"]);
  });

  it("steps over research that is missing, null or the wrong shape", () => {
    expect(
      harvestFromResearch([
        { research: null },
        { research: "not an object" },
        { research: {} },
        { research: { relatedKeywords: "nope" } },
        { research: { relatedKeywords: [{ nothing: 1 }, { keyword: "  " }] } },
      ]),
    ).toEqual([]);
  });
});

describe("playbookCandidates — what the customer told us", () => {
  it("names the audiences the person confirmed", () => {
    const terms = playbookCandidates(PROFILE, "qasimcode.com").join(" | ");
    expect(terms).toContain("dental clinics");
    expect(terms).toContain("salons");
  });

  it("asks the price question the category gets asked", () => {
    expect(playbookCandidates(PROFILE, "qasimcode.com").some((t) => t.startsWith("how much does"))).toBe(true);
  });

  it("uses the audience-shaped playbooks, not the brand-shaped ones", () => {
    expect(TOP_UP_PLAYBOOKS).toContain("use_case");
    expect(TOP_UP_PLAYBOOKS).not.toContain("integrations");
  });

  it("returns nothing rather than guessing when there is no profile", () => {
    expect(playbookCandidates(null, "qasimcode.com")).toEqual([]);
  });
});

describe("newCandidates", () => {
  it("drops what the workspace already has, whatever the casing", () => {
    expect(newCandidates(["Web Design", "salon website"], ["web design"])).toEqual(["salon website"]);
  });

  it("de-duplicates within the harvest itself", () => {
    expect(newCandidates(["a", "A", " a "], [])).toEqual(["a"]);
  });
});

describe("worthStoring — the filter that makes this worth doing", () => {
  const subject = subjectVocabulary(PROFILE, null);
  const opts = { authority: 0, subject, description: PROFILE.description };

  it("refuses the head terms that left the pool unwritable", () => {
    // "web design agency", 12,100/mo at KD 81, is the shape of everything
    // qasimcode had left. Storing more of these refills nothing.
    expect(worthStoring(metric({ term: "web design agency", volume: 12100, difficulty: 81 }), opts)).toBe(false);
  });

  it("keeps a long-tail term the site can actually rank for", () => {
    expect(worthStoring(metric({ term: "dental clinic booking website", volume: 210, difficulty: 8 }), opts)).toBe(true);
  });

  it("keeps the same head term for a site with the authority for it", () => {
    expect(
      worthStoring(metric({ term: "web design agency", volume: 12100, difficulty: 81 }), { ...opts, authority: 85 }),
    ).toBe(true);
  });

  it("refuses a term that argues against what the business sells", () => {
    expect(worthStoring(metric({ term: "salon without a website", volume: 900, difficulty: 2 }), opts)).toBe(false);
  });

  it("refuses a term nobody searches", () => {
    expect(worthStoring(metric({ term: "dental clinic website", volume: 5, difficulty: 3 }), opts)).toBe(false);
  });

  it("retains unknown-volume terms for later live qualification", () => {
    expect(worthStoring(metric({ term: "dental clinic website", volume: null, difficulty: 3 }), opts)).toBe(true);
  });

  it("keeps a term whose difficulty is unknown, for the recommender to weigh", () => {
    expect(worthStoring(metric({ term: "dental clinic website", volume: 210, difficulty: null }), opts)).toBe(true);
  });
});

describe("rankForStorage — relevance ranks, it does not reject", () => {
  const m = (term: string, volume: number): TermMetrics => metric({ term, volume });
  // Harvested from qasimcode.com's own articles, with the relevance its
  // topical profile actually gave them.
  const relevance: Record<string, number> = {
    "web developers near me": 0.0,
    "citysearch business listing": 0.0,
    "best dentist websites": 0.67,
    "web design firms": 0.94,
  };
  const rel = (t: string) => relevance[t] ?? 0;

  it("puts the on-topic term above a term with thirty times the volume", () => {
    const out = rankForStorage([m("web developers near me", 22200), m("best dentist websites", 210)], rel, 10);
    expect(out.map((x) => x.term)).toEqual(["best dentist websites", "web developers near me"]);
  });

  it("drops the noise past the cap rather than storing it over a better term", () => {
    const out = rankForStorage(
      [m("citysearch business listing", 70), m("web design firms", 14800), m("best dentist websites", 210)],
      rel,
      2,
    );
    expect(out.map((x) => x.term)).toEqual(["web design firms", "best dentist websites"]);
  });

  it("still keeps an off-vocabulary term when there is room: it is a candidate, not a verdict", () => {
    const out = rankForStorage([m("web developers near me", 22200), m("best dentist websites", 210)], rel, 10);
    expect(out.map((x) => x.term)).toContain("web developers near me");
  });

  it("breaks a relevance tie on volume", () => {
    const flat = () => 0.5;
    const out = rankForStorage([m("a", 100), m("b", 900)], flat, 10);
    expect(out.map((x) => x.term)).toEqual(["b", "a"]);
  });
});

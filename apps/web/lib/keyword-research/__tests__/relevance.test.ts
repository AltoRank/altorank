import { describe, it, expect } from "vitest";
import { judgeCandidates, judgeFrom } from "../relevance";
import type { ResearchCandidate } from "../types";
import type { TopicalProfile } from "@/lib/seo/topical-profile";

/** A packout SaaS, as its wizard described it. */
const business = {
  name: "PackHub",
  language: "English",
  country: "Global (English)",
  description: "Scan-driven packout for fulfillment teams. Connects to Shopify, validates orders, guides packing, prints shipping labels.",
  audiences: ["Shopify fulfillment teams", "E-commerce warehouse managers", "3PL providers"],
  competitors: ["shipstation.com", "sortly.com"],
};

/** What a crawl of that site produced. */
const site: TopicalProfile = {
  terms: { packout: 10, pack: 9, scan: 8, fulfillment: 7, shopify: 5, labels: 4, orders: 4, warehouse: 3, teams: 3 },
  topTerms: ["packout", "pack", "scan", "fulfillment", "shopify"],
  builtAt: "2026-09-09T18:49:06Z",
} as unknown as TopicalProfile;

const c = (term: string): ResearchCandidate => ({ term, volume: 1000, difficulty: 20, cpc: null, intent: "info", origin: "test", existingId: null, existingStatus: null });

describe("judgeFrom: what the terms are judged against", () => {
  it("uses the site's own pages when it has been read", () => {
    const j = judgeFrom(business, site, "packhub.io");
    expect(j.basis).toBe("site");
    expect(j.judge("shopify packout scan").score).toBeGreaterThan(0);
    expect(j.judge("shopify packout scan").basis).toBe("site");
    // "ups" and "calculator" appear nowhere on the site: the article the
    // 2026-09-09 signup got written on this is what the site basis refuses.
    expect(j.judge("ups shipping calculator").score).toBe(0);
  });

  it("falls back to the business profile when the site has no vocabulary, and says so", () => {
    // The 2026-09-09 case: research eleven minutes before the crawl succeeded.
    const j = judgeFrom(business, null, "packhub.io");
    expect(j.basis).toBe("business");
    expect(j.note).toContain("business profile only");
    expect(j.judge("shopify fulfillment software").score).toBeGreaterThan(0);
    // Terms the profile never mentions: 0, the same bar the first look uses.
    expect(j.judge("ups calculator").score).toBe(0);
    expect(j.judge("shortly").score).toBe(0);
    // The limit of this basis, stated: the customer wrote "shipping labels",
    // so a shipping query is on their subject by their own words. Only the
    // site's vocabulary can reject it - which is why the judge crawls first
    // and lands here only when the site cannot be read.
    expect(j.judge("ups shipping calculator").score).toBe(0.5);
  });

  it("keeps a term a word of which the customer named, even if the site never wrote it", () => {
    const j = judgeFrom(business, null, "packhub.io");
    // Competitor and audience words are the gaps worth writing.
    expect(j.judge("sortly alternatives").score).toBeGreaterThan(0);
    expect(j.judge("3pl provider checklist").score).toBeGreaterThan(0);
  });

  it("says when there is nothing to judge against at all", () => {
    const j = judgeFrom(null, null, "example.com");
    expect(j.basis).toBe("none");
    expect(j.note).toContain("nothing to judge relevance against");
    // Not a veto of everything - a table of zeros would be a lie too - but
    // the callers that store keywords read `basis` and refuse.
    expect(j.judge("anything at all").score).toBe(1);
  });

  it("carries the refresh outcome into the note", () => {
    expect(judgeFrom(business, site, "packhub.io", "read the site first").note).toMatch(/^Read the site first; /);
    expect(judgeFrom(business, null, "packhub.io", "could not read the site (timed out)").note).toMatch(/^Could not read the site \(timed out\); /);
  });
});

describe("judgeCandidates", () => {
  it("attaches a judgement to every candidate and drops none", () => {
    const j = judgeFrom(business, null, "packhub.io");
    const out = judgeCandidates([c("shopify packing"), c("ups calculator")], j);
    expect(out).toHaveLength(2);
    expect(out[0].relevance?.score).toBeGreaterThan(0);
    expect(out[1].relevance).toMatchObject({ score: 0, basis: "business" });
    expect(out[1].relevance?.reason).toContain("business profile");
  });
});

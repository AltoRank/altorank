import { describe, expect, it } from "vitest";
import {
  businessLine,
  competitorEntry,
  finishBlocker,
  localeLine,
  preTickRival,
  siteSummary,
  withExampleUrl,
  withPendingCompetitor,
  wizardExamples,
} from "../wizard-rules";
import { EMPTY_PROFILE, type BusinessProfile } from "../profile-shape";
import type { CompetitorSuggestion } from "../competitor-suggestions";

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  ...EMPTY_PROFILE,
  name: "Acme Physio",
  description: "Acme Physio treats back pain in Milan. Book online.",
  offerings: ["back pain treatment", "sports massage"],
  ...over,
});
const s = (domain: string, size: CompetitorSuggestion["size"], source: CompetitorSuggestion["source"] = "serp"): CompetitorSuggestion => ({ domain, size, source, authority: null });

describe("competitors are optional (UX audit #2)", () => {
  it("never stops the main button for an empty competitor list", () => {
    expect(finishBlocker(profile({ competitors: [], competitorNames: [] }))).toBeNull();
  });

  it("stops it only when there is nothing to plan from, and names the field", () => {
    expect(finishBlocker(profile({ offerings: [], description: "" }))).toEqual({
      field: "offerings",
      message: "Add one thing people buy from you, so we know what to write about.",
    });
    expect(finishBlocker(profile({ offerings: ["  "], description: " " }))?.field).toBe("offerings");
    expect(finishBlocker(profile({ offerings: [], description: "We fix boilers." }))).toBeNull();
  });

  it("ticks the best suggestion when none is chosen: your size before bigger", () => {
    expect(preTickRival([], [s("big.example", "bigger"), s("peer.example", "similar")])?.domain).toBe("peer.example");
    expect(preTickRival([], [s("big.example", "bigger")])?.domain).toBe("big.example");
    expect(preTickRival([], [s("unmeasured.example", null)])?.domain).toBe("unmeasured.example");
    expect(preTickRival(["mine.example"], [s("peer.example", "similar")])).toBeNull();
    expect(preTickRival([], [])).toBeNull();
  });

  it("takes a plain business name as a name, and a website as a website", () => {
    expect(competitorEntry("  Studio Acme  Fisioterapia ")).toEqual({ kind: "name", text: "Studio Acme Fisioterapia" });
    expect(competitorEntry("https://www.Rival-Clinic.example/about")).toEqual({ kind: "domain", text: "rival-clinic.example" });
    expect(competitorEntry("   ")).toBeNull();
  });

  it("keeps text left in the box on the final click, without looking it up", () => {
    const p = profile({ competitors: ["a.example"] });
    expect(withPendingCompetitor(p, "Bottega Acme").competitorNames).toEqual(["Bottega Acme"]);
    expect(withPendingCompetitor(p, "b.example").competitors).toEqual(["a.example", "b.example"]);
    expect(withPendingCompetitor(p, "a.example")).toBe(p);
    expect(withPendingCompetitor({ ...p, competitorNames: ["Bottega Acme"] }, "bottega acme").competitorNames).toEqual(["Bottega Acme"]);
    expect(withPendingCompetitor(p, "")).toBe(p);
  });
});

describe("the collapsed lines", () => {
  it("does not repeat the name when the description starts with it", () => {
    expect(businessLine(profile())).toBe("Acme Physio treats back pain in Milan.");
    expect(businessLine(profile({ description: "We treat back pain." }))).toBe("Acme Physio · We treat back pain.");
    expect(businessLine(profile({ name: "", description: "" }))).toBe("");
  });

  it("always says the language and market", () => {
    expect(localeLine(profile({ language: "Italian", country: "Italy" }))).toBe("Italian · Italy");
    expect(localeLine(EMPTY_PROFILE)).toBe("English · Global (English)");
  });

  it("calls a site with no blog optional and calm, never a warning", () => {
    const none = siteSummary({ sitemapUrl: "", blogRootUrl: "", exampleArticleUrls: [] }, false, "acme.example");
    expect(none.badge).toBe("optional");
    expect(none.line).toMatch(/^No blog yet/);
    expect(none.line).not.toMatch(/sitemap|search console|needs a look/i);
    expect(siteSummary({ sitemapUrl: "", blogRootUrl: "https://acme.example/blog/", exampleArticleUrls: ["x"] }, false, "acme.example")).toEqual({
      line: "Found your blog, 1 example post",
      badge: "found",
    });
    expect(siteSummary({ sitemapUrl: "", blogRootUrl: "", exampleArticleUrls: [] }, true, "acme.example").badge).toBe("looking");
    expect(siteSummary({ sitemapUrl: "", blogRootUrl: "", exampleArticleUrls: ["", "x"] }, false, "acme.example").line).toBe("1 example post");
  });

  it("keeps an example typed into the second field in the second field", () => {
    expect(withExampleUrl(["", "", ""], 1, "h")).toEqual(["", "h"]);
    expect(withExampleUrl(["", "h", ""], 1, "ht")).toEqual(["", "ht"]);
    expect(withExampleUrl(["a", "h", ""], 1, "")).toEqual(["a"]);
    expect(withExampleUrl(["", "", ""], 0, "")).toEqual([]);
  });
});

describe("examples in the owner's words (UX audit #12)", () => {
  it("builds them from what the business sells", () => {
    const ex = wizardExamples(profile());
    expect(ex.offeringHelp).toContain("“back pain treatment”");
    expect(ex.audiencePlaceholder).toBe("e.g. people looking for back pain treatment");
  });

  it("falls back to plain small-business examples, and never SaaS or SEO ones", () => {
    const all = Object.values(wizardExamples({ offerings: [] })).join(" ");
    expect(all).toMatch(/sports massage|back pain/);
    expect(all).not.toMatch(/SaaS|software|keyword|rank|order picking|B2B|sitemap/i);
  });
});

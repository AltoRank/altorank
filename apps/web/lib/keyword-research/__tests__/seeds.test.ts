import { describe, expect, it } from "vitest";
import { buildPlaybookSeeds, competitorName, keyNouns, playbookExamples, PLAYBOOKS, INTEGRATION_NAMES } from "../seeds";

const profile = {
  description: "Cal.com is open source scheduling software for teams. Scheduling infrastructure for everyone; book meetings without the back and forth.",
  audiences: ["Sales teams", "Recruiters"],
  competitors: ["calendly.com", "www.acuityscheduling.com", "https://savvycal.com/"],
};
const ctx = { brand: "cal.com", profile };

describe("competitorName", () => {
  it("drops the TLD and www for a normal domain", () => {
    expect(competitorName("www.acuityscheduling.com")).toBe("acuityscheduling");
    expect(competitorName("https://savvycal.com/pricing")).toBe("savvycal");
  });
  it("keeps a short name whole, because 'cal alternatives' is a different query", () => {
    expect(competitorName("cal.com")).toBe("cal.com");
  });
});

describe("buildPlaybookSeeds", () => {
  it("alternatives: singular and plural per competitor, lower-cased, no duplicates", () => {
    const seeds = buildPlaybookSeeds("alternatives", ctx);
    expect(seeds).toContain("calendly alternatives");
    expect(seeds).toContain("calendly alternative");
    expect(seeds).toHaveLength(6);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
  it("vs: us against each competitor, then every competitor pair once", () => {
    const seeds = buildPlaybookSeeds("vs", ctx);
    expect(seeds.slice(0, 3)).toEqual(["cal.com vs calendly", "cal.com vs acuityscheduling", "cal.com vs savvycal"]);
    expect(seeds).toContain("calendly vs acuityscheduling");
    expect(seeds).not.toContain("acuityscheduling vs calendly");
    expect(seeds).toHaveLength(6);
  });
  it("best-of and use-case take the category from the description and one row per audience", () => {
    const best = buildPlaybookSeeds("best_of", { ...ctx, category: "scheduling software" });
    expect(best).toEqual(["best scheduling software for sales teams", "best scheduling software for recruiters"]);
    const use = buildPlaybookSeeds("use_case", { ...ctx, category: "scheduling software" });
    expect(use).toEqual(["scheduling software for sales teams", "scheduling software for recruiters"]);
  });
  it("integrations: one per supported tool, with the brand", () => {
    const seeds = buildPlaybookSeeds("integrations", ctx);
    expect(seeds).toHaveLength(INTEGRATION_NAMES.length);
    expect(seeds[0]).toBe("cal.com wordpress integration");
  });
  it("pricing: per competitor plus the category cost question", () => {
    const seeds = buildPlaybookSeeds("pricing", { ...ctx, category: "scheduling software" });
    expect(seeds).toContain("calendly pricing");
    expect(seeds).toContain("how much does scheduling software cost");
  });
  it("glossary: 'what is' over the description's key nouns", () => {
    const seeds = buildPlaybookSeeds("glossary", ctx);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.every((s) => s.startsWith("what is "))).toBe(true);
    expect(seeds.join(" ")).toContain("scheduling");
  });
  it("returns [] and does not throw when the profile lacks what the playbook needs", () => {
    const bare = { brand: "", profile: { description: "", audiences: [], competitors: [] } };
    for (const p of PLAYBOOKS) expect(buildPlaybookSeeds(p.id, bare)).toEqual([]);
  });
  it("examples are the first few seeds", () => {
    expect(playbookExamples("alternatives", ctx, 2)).toEqual(buildPlaybookSeeds("alternatives", ctx).slice(0, 2));
  });
});

describe("keyNouns", () => {
  it("prefers repeated adjacent pairs and skips stopwords", () => {
    const nouns = keyNouns("Warehouse orchestration for modern teams. Our warehouse orchestration platform helps teams orchestrate warehouses.");
    expect(nouns[0]).toBe("warehouse orchestration");
    expect(nouns).not.toContain("our");
    expect(nouns).not.toContain("teams");
  });
  it("returns [] for empty text", () => {
    expect(keyNouns("")).toEqual([]);
  });
});

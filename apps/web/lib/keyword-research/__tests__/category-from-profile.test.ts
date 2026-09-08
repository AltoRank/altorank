import { describe, it, expect } from "vitest";
import { buildPlaybookSeeds, categoryOf, keyNouns } from "../seeds";

// The real profile the product inferred for qasimcode.com on 2026-09-07, whose
// 20 stored keywords contained not one of book, appoint, clinic, salon, dental,
// therapy, trade or calendar.
const QASIMCODE = {
  description:
    "Qasimcode builds appointment-based websites for clinics, salons, studios, and trades, with online booking integrated to existing calendars. Sites are written, built, and deployed live within two to four weeks at a fixed price agreed upfront.",
  audiences: [
    "Speech therapy practices",
    "Medical and dental clinics",
    "Salons and beauty studios",
    "Trades and service businesses",
  ],
  competitors: ["acuityscheduling.com", "calendly.com"],
};

describe("categoryOf", () => {
  it("takes the category from where the description says what it does, not from where it sorts", () => {
    // Every pair in a one-paragraph description occurs exactly once, so the old
    // frequency sort fell through to alphabetical: "agreed upfront" beat
    // "appointment-based websites" because "agr" < "app".
    expect(categoryOf(QASIMCODE, "qasimcode")).toBe("appointment-based websites");
  });

  it("drops the brand and the verb the description opens with", () => {
    expect(categoryOf(QASIMCODE, "qasimcode")).not.toContain("qasimcode");
    expect(categoryOf(QASIMCODE, "qasimcode")).not.toMatch(/^builds\b/);
  });

  it("still answers when the brand is unknown", () => {
    expect(categoryOf(QASIMCODE)).toBeTruthy();
  });

  it("prefers the earlier phrase only when frequency ties", () => {
    // "coffee beans" is said twice and arrives second; frequency must still win.
    const p = { description: "Acme sells kitchen gadgets. Coffee beans, more coffee beans." };
    expect(keyNouns(p.description, 1)).toEqual(["coffee beans"]);
  });
});

describe("audience playbooks with a real profile", () => {
  it("names the buyer and the thing sold, which is what the site's headings never do", () => {
    const seeds = buildPlaybookSeeds("use_case", { brand: "qasimcode", profile: QASIMCODE });
    expect(seeds).toContain("appointment-based websites for medical and dental clinics");
    expect(seeds).toContain("appointment-based websites for speech therapy practices");
  });

  it("returns nothing rather than a template when there are no audiences", () => {
    expect(
      buildPlaybookSeeds("use_case", { brand: "x", profile: { ...QASIMCODE, audiences: [] } }),
    ).toEqual([]);
  });
});

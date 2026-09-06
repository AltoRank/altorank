import { describe, it, expect } from "vitest";
import { proposeHunks, decideAll, reviewableHunks } from "../proposals";
import { blockNoun, changeReport, followUpChips, reportHeadline, sectionsOf } from "../rewrite-report";

const before = [
  "<p>Intro paragraph, long and slow.</p>",
  "<h2>Pricing</h2>",
  '<p>Pricing text with <a href="/plans">a link</a>.</p>',
  "<p>More pricing text.</p>",
  "<h2>Setup</h2>",
  "<p>Setup text.</p>",
  "<h2>Conclusion</h2>",
  "<p>The end.</p>",
].join("");

const after = [
  "<p>Intro paragraph, short.</p>",
  "<h2>Pricing</h2>",
  '<p>Pricing text, tightened, with <a href="/plans">a link</a>.</p>',
  "<p>More pricing text.</p>",
  "<h2>Setup</h2>",
  "<p>Setup text.</p>",
  "<ul><li>Step one</li></ul>",
  "<h2>Conclusion</h2>",
  "<p>The end.</p>",
].join("");

const hunks = proposeHunks(before, after);
const open = reviewableHunks(hunks);
// intro changed, pricing paragraph changed, setup list added
const [intro, pricing, setupList] = open;

describe("sectionsOf", () => {
  it("puts blocks before the first H2 in the intro and the rest under their heading", () => {
    const sections = sectionsOf(hunks);
    expect(sections[0]).toEqual({ heading: null, index: 0 });
    expect(sections[hunks.indexOf(pricing)]).toEqual({ heading: "Pricing", index: 1 });
    expect(sections[hunks.indexOf(setupList)]).toEqual({ heading: "Setup", index: 2 });
  });
});

describe("blockNoun", () => {
  it("names blocks by their outer tag", () => {
    expect(blockNoun("<p>x</p>")).toBe("paragraph");
    expect(blockNoun("<h2>x</h2>")).toBe("heading");
    expect(blockNoun("<ol><li>x</li></ol>")).toBe("list");
    expect(blockNoun("<pre>x</pre>")).toBe("code block");
    expect(blockNoun(null)).toBe("block");
  });
});

describe("changeReport", () => {
  const modelChanges = [
    "Shortened the intro to one line",
    "Tightened the Pricing section",
    "Added a step list under Setup",
    "Same links and images kept in place",
  ];

  it("counts only kept hunks and reports them by block type", () => {
    const r = changeReport(hunks, decideAll(hunks, "accepted"), modelChanges, before);
    expect(r.kept).toBe(3);
    expect(r.total).toBe(3);
    expect(r.facts).toEqual(["2 paragraphs rewritten", "1 list added"]);
    expect(r.sections).toEqual([
      { heading: null, kept: 1, total: 1 },
      { heading: "Pricing", kept: 1, total: 1 },
      { heading: "Setup", kept: 1, total: 1 },
    ]);
    expect(r.assetsIntact).toBe(true);
    expect(reportHeadline(r)).toBe("Applied all 3 changes.");
  });

  it("with everything kept the model's account stands, minus asset claims we measure ourselves", () => {
    const r = changeReport(hunks, decideAll(hunks, "accepted"), modelChanges, before);
    expect(r.notes).toEqual(["Shortened the intro to one line", "Tightened the Pricing section", "Added a step list under Setup"]);
    expect(r.droppedNotes).toBe(1);
  });

  it("never lists a note about a rejected hunk", () => {
    const decisions = { [intro.id]: "accepted" as const, [pricing.id]: "rejected" as const, [setupList.id]: "accepted" as const };
    const r = changeReport(hunks, decisions, modelChanges, before);
    expect(r.notes).not.toContain("Tightened the Pricing section");
    expect(r.notes).toEqual(["Shortened the intro to one line", "Added a step list under Setup"]);
    expect(r.facts).toEqual(["1 paragraph rewritten", "1 list added"]);
    expect(r.sections.find((s) => s.heading === "Pricing")).toEqual({ heading: "Pricing", kept: 0, total: 1 });
    expect(reportHeadline(r)).toBe("Applied 2 of 3 changes; the rest stays as it was.");
  });

  it("with nothing kept there are no notes, no facts, and the headline says so", () => {
    const r = changeReport(hunks, decideAll(hunks, "rejected"), modelChanges, before);
    expect(r.kept).toBe(0);
    expect(r.notes).toEqual([]);
    expect(r.facts).toEqual([]);
    expect(r.droppedNotes).toBe(modelChanges.length);
    expect(reportHeadline(r)).toBe("Nothing kept. The article is as it was.");
  });

  it("a generic note with no section and no shared words is dropped when the review is partial", () => {
    const decisions = { [intro.id]: "rejected" as const, [pricing.id]: "accepted" as const, [setupList.id]: "rejected" as const };
    const r = changeReport(hunks, decisions, ["Tighter sentences and smoother transitions"], before);
    expect(r.notes).toEqual([]);
    expect(r.droppedNotes).toBe(1);
  });

  it("flags a link the kept mix lost", () => {
    // The link moves from one paragraph into another; keeping only the
    // paragraph it left drops it from the article.
    const b = '<p>One <a href="/x">x</a>.</p><p>Two.</p>';
    const a = '<p>One.</p><p>Two <a href="/x">x</a>.</p>';
    const h = proposeHunks(b, a);
    const [first, second] = reviewableHunks(h);
    const r = changeReport(h, { [first.id]: "accepted", [second.id]: "rejected" }, [], b);
    expect(r.assetsIntact).toBe(false);
    expect(r.missingAssets).toEqual(["/x"]);
    expect(changeReport(h, decideAll(h, "accepted"), [], b).assetsIntact).toBe(true);
  });

  it("a no-op rewrite reports no changes", () => {
    const h = proposeHunks(before, before);
    const r = changeReport(h, {}, ["Nothing"], before);
    expect(r.total).toBe(0);
    expect(reportHeadline(r)).toBe("The rewrite proposed no changes to the article.");
  });
});

describe("followUpChips", () => {
  it("is empty when nothing was kept, so the panel falls back to its opening chips", () => {
    expect(followUpChips(hunks, decideAll(hunks, "rejected"))).toEqual([]);
    expect(followUpChips(hunks, {})).toEqual([]);
  });

  it("reads the intro, the busiest section, an untouched section and the ending off the kept hunks", () => {
    const chips = followUpChips(hunks, decideAll(hunks, "accepted"));
    expect(chips).toHaveLength(4);
    expect(chips[0]).toBe("Shorten the intro even more");
    // Pricing and Setup tie at one kept hunk; Pricing comes first and has a link.
    expect(chips[1]).toBe("Add a concrete example to “Pricing”");
    expect(chips[2]).toBe("Apply the same treatment to “Conclusion”");
    expect(chips[3]).toBe("Add a stronger conclusion");
  });

  it("changes with the decisions: an untouched intro and a source-less section", () => {
    const decisions = { [intro.id]: "rejected" as const, [pricing.id]: "rejected" as const, [setupList.id]: "accepted" as const };
    const chips = followUpChips(hunks, decisions);
    expect(chips[0]).toBe("Bring the intro in line with the rewritten sections");
    expect(chips[1]).toBe("Add a source for “Setup”");
    expect(chips).toContain("Apply the same treatment to “Pricing”");
  });

  it("always returns at least three, even for an article with no headings", () => {
    const h = proposeHunks("<p>a</p><p>b</p>", "<p>A</p><p>B</p>");
    const chips = followUpChips(h, decideAll(h, "accepted"));
    expect(chips.length).toBeGreaterThanOrEqual(3);
    expect(chips.length).toBeLessThanOrEqual(4);
    expect(new Set(chips).size).toBe(chips.length);
  });
});

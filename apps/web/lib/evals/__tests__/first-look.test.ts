import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { firstLookShortfalls, loadFirstLookCases, runFirstLook, type FirstLookCase, type FloorLabel } from "../first-look";
import { runEvals } from "../run";
import { renderMarkdown } from "../score";

// The yield eval replays whole first looks through the product's planner on
// stored answers and stored results pages. What it has to prove: a signup
// whose site gave us a usable profile ends with a planned article, by which
// rung, and that the picks made below the bar are ones an owner would
// publish. The sample is invented.

const SAMPLE = path.join(__dirname, "..", "fixtures", "sample");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "altorank-first-look-"));
  cpSync(SAMPLE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const caseFile = (id: string) => path.join(dir, "first-look", `${id}.json`);
const edit = (id: string, change: (c: FirstLookCase) => void) => {
  const c = JSON.parse(readFileSync(caseFile(id), "utf8")) as FirstLookCase;
  change(c);
  writeFileSync(caseFile(id), JSON.stringify(c));
};
const labelsFile = () => path.join(dir, "first-look-labels", "floor-picks.json");

describe("first-look yield on the sample", () => {
  it("plans an article for every case with a usable profile, each by the rung its case is about", async () => {
    const { report } = await runFirstLook(dir);
    expect(report).toMatchObject({ cases: 6, usable: 5, planned: 5, yield: 1, proposed: 0 });
    const rung = (id: string) => report.runs.find((r) => r.caseId === id);
    expect(rung("first-twelve-rejected")).toMatchObject({ ending: "planned", rung: "extended", resultsRead: 16 });
    expect(rung("providers-win-every-search")).toMatchObject({ ending: "planned", rung: "second_ask", modelCalls: 2 });
    expect(rung("question-cited-from-related-search")).toMatchObject({ ending: "planned", rung: "related_evidence", lower: true });
    expect(rung("suggest-reply-cut-off")).toMatchObject({ ending: "planned", rung: "ranked" });
    expect(rung("thin-site-owner-answer")).toMatchObject({ ending: "planned", rung: "ranked" });
    expect(report.byRung).toEqual({ extended: 1, second_ask: 1, related_evidence: 1, ranked: 2 });
    // The share link is refused at the field, with the sentence, and is not in the yield.
    expect(report.notUsable).toEqual([expect.objectContaining({ caseId: "share-link-as-website", ending: "refused", reason: expect.stringMatching(/share link, not your website/) })]);
    // Both picks made below the bar are labelled as worth publishing.
    expect(report.floor).toMatchObject({ picks: 2, yes: 2, no: 0, unlabelled: 0 });
    expect(firstLookShortfalls(report)).toEqual([]);
  });

  it("names no real site: every case is on a reserved example domain", () => {
    for (const c of loadFirstLookCases(SAMPLE)) {
      const hosts = [c.url, ...Object.values(c.serps).flat().map((r) => r.url)].map((u) => new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname);
      for (const host of hosts) expect(host === "share.google" || host.endsWith(".example"), `${c.id}: ${host}`).toBe(true);
    }
  });

  it("runs in the harness, free in replay, with its own section in the report", async () => {
    const result = await runEvals({ dir, mode: "replay", model: "m", rate: { input: 1, output: 5 }, maxUsd: 0, only: ["first-look-yield"] });
    expect(result.recorder.misses).toBe(0);
    expect(result.recorder.budget.spentUsd).toBe(0);
    expect(result.scores).toEqual([expect.objectContaining({ decision: "first-look-yield", n: 6, agreed: 6 })]);
    const markdown = renderMarkdown({ title: "Decision evals", scores: result.scores, items: result.items, meta: {}, firstLook: result.firstLook });
    expect(markdown).toContain("First-look yield (usable-profile cases that planned an article): **5/5 (100%)**");
    expect(markdown).toContain("Planned by rung: extended 1, second_ask 1, related_evidence 1, ranked 2.");
    expect(markdown).toContain("| providers-win-every-search | yes | planned | second_ask | how much does a garden room cost | 9 | 2 |");
  });
});

describe("what --require-complete holds a case set to", () => {
  it("fails when a usable-profile case plans no article, and says which and why", async () => {
    // Nothing anywhere to cite: the second ask's pages are providers' pages too.
    edit("providers-win-every-search", (c) => {
      for (const term of Object.keys(c.serps)) c.serps[term] = c.serps["garden room installers"];
      c.expect = undefined;
    });
    const { report } = await runFirstLook(dir);
    expect(report).toMatchObject({ usable: 5, planned: 4, proposed: 1 });
    expect(report.yield).toBe(0.8);
    expect(report.nothing).toEqual([expect.objectContaining({ caseId: "providers-win-every-search", ending: "proposed", reason: expect.stringMatching(/one was proposed to the owner/) })]);
    const shortfalls = firstLookShortfalls(report);
    expect(shortfalls[0]).toBe("First-look yield is 4/5: providers-win-every-search (proposed) planned no article.");
    // The proposed topic is a pick made below the bar too: its label still applies.
    expect(report.nothing[0]).toBeDefined();
    expect(report.runs.find((r) => r.caseId === "providers-win-every-search")).toMatchObject({ term: "how much does a garden room cost" });
    expect(report.floor).toMatchObject({ picks: 2, yes: 2 });
    expect(shortfalls).toHaveLength(1);
  });

  it("fails when the model did not answer either ask: that is a first look with nothing", async () => {
    edit("suggest-reply-cut-off", (c) => { c.answers = { suggest: null, secondAsk: null }; c.expect = undefined; });
    const { report } = await runFirstLook(dir, ["suggest-reply-cut-off"]);
    expect(report.nothing).toEqual([expect.objectContaining({ ending: "nothing", reason: expect.stringMatching(/^provider:/) })]);
    expect(firstLookShortfalls(report)).toHaveLength(1);
  });

  it("fails when a pick made below the bar is one its owner would not publish, or has no label", async () => {
    const labels = JSON.parse(readFileSync(labelsFile(), "utf8")) as FloorLabel[];
    writeFileSync(labelsFile(), JSON.stringify(labels.map((l) => (l.caseId === "question-cited-from-related-search" ? { ...l, publish: "no", note: "Reads as a price list, not an article." } : l))));
    const junk = (await runFirstLook(dir)).report;
    expect(junk.yield).toBe(1);
    expect(junk.floor).toMatchObject({ yes: 1, no: 1, unlabelled: 0 });
    expect(firstLookShortfalls(junk)).toEqual([expect.stringMatching(/1 pick made below the bar is labelled as not worth publishing: question-cited-from-related-search "how much are pottery class prices"/)]);
    writeFileSync(labelsFile(), JSON.stringify(labels.slice(0, 1)));
    const unlabelled = (await runFirstLook(dir)).report;
    expect(unlabelled.floor).toMatchObject({ yes: 1, no: 0, unlabelled: 1 });
    expect(firstLookShortfalls(unlabelled)).toHaveLength(1);
  });

  it("fails when a case does not end the way it says it should", async () => {
    edit("share-link-as-website", (c) => { c.redirects = { "https://share.google/EXAMPLEabc123": "https://www.sugarloft-cakes.example/" }; });
    const followed = (await runFirstLook(dir, ["share-link-as-website"])).report;
    // The link now leads to a site, so it is not refused; with no profile it asks the owner.
    expect(followed.runs[0]).toMatchObject({ ending: "needs_business" });
    expect(firstLookShortfalls(followed)).toEqual(["share-link-as-website: expected refused, got needs_business."]);
  });

  it("does not count a thin site as usable until its owner answers", async () => {
    edit("thin-site-owner-answer", (c) => { c.ownerAnswer = null; });
    const { report } = await runFirstLook(dir, ["thin-site-owner-answer"]);
    expect(report.runs[0]).toMatchObject({ ending: "needs_business", modelCalls: 0, resultsRead: 0 });
  });
});

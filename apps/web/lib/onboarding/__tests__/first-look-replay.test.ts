import { describe, expect, it, vi } from "vitest";
import { memoryDb } from "@/lib/evals/memory-db";
import type { SerpData } from "@/lib/seo/brief-data";
import { planFirstLook } from "../first-look-plan";
import { FIRST_LOOK_REPLAY_VERSION, replayOf, replayRow, saveFirstLookReplay, serpOfRead } from "../first-look-replay";

// A first look's results pages lived only in memory, so a run that planned
// nothing could not be looked at again without buying every page. What it
// read is kept with the run, and is enough to run the same plan for free.

const BUSINESS = { name: "Oakframe", description: "Oakframe designs and installs garden offices for homeowners.", offerings: ["garden offices"] };
const seed = () => memoryDb({ workspaces: [{ id: "ws1", domain: "oakframe.example", language: "en", location_code: 2826, dr: 4, business_profile: BUSINESS }] });
const topic = (query: string) => ({ query, fromList: false, reader: "Homeowners", job: `Understand ${query}`, offering: "The design visit", angle: `${query}: a plain guide`, shape: "explainer", fit: 4, kind: "question", why: "Its readers ask this first." });
const articles = (term: string): SerpData => ({
  organic: [1, 2, 3].map((n) => ({ rank: n, title: `${term}: a guide (${n})`, url: `https://journal-${n}.example/blog/${term.replace(/ /g, "-")}`, description: `A guide to ${term}.`, domain: `journal-${n}.example`, wordCount: 900 })),
  peopleAlsoAsk: [], aiOverview: null,
});
const providers = (term: string): SerpData => ({
  organic: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ rank: n, title: `${term} | Installer ${n} | Book now`, url: `https://installer-${n}.example/`, description: `${term} done for you. Call us`, domain: `installer-${n}.example`, wordCount: 300 })),
  peopleAlsoAsk: [], aiOverview: null,
});
const options = { firstLook: { serps: new Map<string, SerpData>() }, weeklyLimit: 2, hold: async () => "held" as const, decorate: false as const, rivalPages: async () => [], metrics: async () => new Map(), now: new Date("2026-11-20T12:00:00Z") };

describe("a first look's reads, kept for replay", () => {
  it("stores the topics asked and each page read, compact, and replays to the same plan with nothing bought", async () => {
    const ask = vi.fn(async (operation: string) => JSON.stringify({ topics: operation.endsWith("second-ask") ? [topic("how much does a garden office cost")] : [topic("garden office installers"), topic("garden office company")] }));
    const serp = vi.fn(async (term: string) => (term.startsWith("how much") ? articles(term) : providers(term)));
    const live = await planFirstLook(seed().db, "ws1", { ...options, firstLook: { serps: new Map() }, ask, serp });
    expect(live.outcome).toBe("planned");

    const row = replayRow({ runId: "run1", workspaceId: "ws1", languageCode: "en", locationCode: 2826, result: live });
    expect(row).toMatchObject({ run_id: "run1", workspace_id: "ws1", version: FIRST_LOOK_REPLAY_VERSION, outcome: "planned", rung: "second_ask", language_code: "en", location_code: 2826 });
    expect(row.asked.suggested.map((t) => t.query)).toEqual(["garden office installers", "garden office company"]);
    expect(row.asked.secondAsk.map((t) => t.query)).toEqual(["how much does a garden office cost"]);
    expect(row.pages.map((p) => [p.query, p.source, p.verdict])).toEqual([
      ["garden office installers", "suggested", "needs_page"],
      ["garden office company", "suggested", "needs_page"],
      ["how much does a garden office cost", "second_ask", "accepted"],
    ]);
    // Each result with what it was judged to be; nothing but the results page itself.
    expect(row.pages[2].results[0]).toEqual({ rank: 1, url: "https://journal-1.example/blog/how-much-does-a-garden-office-cost", title: "how much does a garden office cost: a guide (1)", description: "A guide to how much does a garden office cost.", domain: "journal-1.example", kind: "editorial", page: "article" });
    expect(serpOfRead(row.pages[2]).organic).toHaveLength(3);

    // Through JSON, as the database hands it back: the same plan, no provider.
    const stored = JSON.parse(JSON.stringify(row)) as typeof row;
    const replayed = await planFirstLook(seed().db, "ws1", { ...options, firstLook: { serps: new Map() }, ...replayOf(stored) });
    expect(replayed.outcome).toBe("planned");
    expect(replayed.plan.map((p) => p.term)).toEqual(live.plan.map((p) => p.term));
    expect(replayed.summary).toMatchObject({ rung: "second_ask", resultsRead: live.summary.resultsRead, rejected: live.summary.rejected });
    // A search the run never read is a provider that did not answer.
    await expect(replayOf(stored).serp("never read")).rejects.toThrow(/No stored results page/);
  });

  it("writes one row per run, and never holds the run when the write fails", async () => {
    const { db, tables } = memoryDb({ first_look_replays: [] });
    const row = replayRow({ runId: "run1", workspaceId: "ws1", languageCode: "en", locationCode: 2826, result: { outcome: "none", summary: { suggested: 1, rejected: {}, resultsRead: 0, resultsFailed: 0, noEvidence: 0, planned: 0, ready: 0, modelCalls: 1 }, reads: [], asked: { suggested: [topic("garden office cost") as never], secondAsk: [] } } });
    expect(await saveFirstLookReplay(db, row)).toBe(true);
    expect(await saveFirstLookReplay(db, { ...row, outcome: "planned" })).toBe(true);
    expect(tables.first_look_replays).toHaveLength(1);
    expect(tables.first_look_replays[0]).toMatchObject({ run_id: "run1", outcome: "planned" });
    // A database without the table (migration 123 not applied), or one that throws.
    const missing = { from: () => ({ upsert: async () => ({ error: { message: 'relation "first_look_replays" does not exist' } }) }) } as never;
    expect(await saveFirstLookReplay(missing, row)).toBe(false);
    const broken = { from: () => { throw new Error("socket hang up"); } } as never;
    expect(await saveFirstLookReplay(broken, row)).toBe(false);
    // A run that asked nothing and read nothing has nothing to keep.
    expect(await saveFirstLookReplay(db, { ...row, run_id: "run2", asked: { suggested: [], secondAsk: [] } })).toBe(false);
    expect(tables.first_look_replays).toHaveLength(1);
  });
});

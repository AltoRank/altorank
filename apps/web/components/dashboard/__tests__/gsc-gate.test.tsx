import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BestArticlesBlock, CannibalizationBlock, DataFreshness, GscGate, SearchPerformanceBlock, gateSentence } from "../gsc-blocks";
import { nextSyncClock } from "@/lib/gsc/freshness";
import type { SearchPerformance } from "@/lib/gsc/analysis";
import type { SyncHealth } from "@/lib/gsc/queries";

// U31: the restated lines were built by dropping a clause into three
// sentences, and two of the three came out as "Connected, and Google has not
// returned there are no clicks or impressions to plot yet." Each block now
// passes what it shows as a noun phrase; these tests read the sentences the
// owner sees, in every gated state, for every block that gates.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

const emptyPerf = {
  days: 28,
  hasData: false,
  hasClicks: false,
  current: [],
  previous: [],
  previousMeasured: false,
  currentMeasured: false,
  currentComplete: true,
  clicks: { current: 0, previous: null, changePct: null },
  impressions: { current: 0, previous: null, changePct: null },
} as unknown as SearchPerformance;

type Gate = { connected: boolean; needsReconnect: boolean };
const STATES: Array<[string, Gate]> = [
  ["refused", { connected: true, needsReconnect: true }],
  ["not connected", { connected: false, needsReconnect: false }],
  ["no rows yet", { connected: true, needsReconnect: false }],
];

function restatedBlocks({ connected, needsReconnect }: Gate): string[] {
  return [
    renderToStaticMarkup(<SearchPerformanceBlock perf={emptyPerf} connected={connected} needsReconnect={needsReconnect} restated />),
    renderToStaticMarkup(<BestArticlesBlock pages={[]} connected={connected} hasData={false} days={28} needsReconnect={needsReconnect} restated />),
    renderToStaticMarkup(<CannibalizationBlock items={[]} connected={connected} hasData={false} days={28} needsReconnect={needsReconnect} restated />),
  ].map(text);
}

describe("gateSentence", () => {
  it("says when the next sync runs, with the clock as nextSyncClock writes it", () => {
    expect(gateSentence("no-rows", "clicks per page", "04:00 UTC")).toBe(
      "Google is connected. Clicks per page arrive after the next sync, at 04:00 UTC.",
    );
    expect(gateSentence("no-rows", undefined, "04:00 UTC")).toBe("Google is connected. The first numbers arrive after the next sync, at 04:00 UTC.");
    // No schedule (a self-hosted copy without the cron): no invented time.
    expect(gateSentence("no-rows", "clicks and impressions", null)).toBe("Google is connected. Clicks and impressions arrive after the next sync.");
  });

  it("words a refused sign-in and a missing connection around the same noun phrase", () => {
    expect(gateSentence("refused", "clicks and impressions")).toBe(
      "Google refused the saved sign-in, so clicks and impressions stopped at the last sync.",
    );
    expect(gateSentence("not-connected", "positions per search")).toBe("Positions per search come from Search Console, which is not connected.");
  });
});

describe("restated Search Console blocks", () => {
  it.each(STATES)("print whole sentences when %s", (_name, gate) => {
    for (const line of restatedBlocks(gate)) {
      expect(line).not.toMatch(/has not returned there are|returned the query-level|returned Google's/);
      expect(line).not.toMatch(/so there are no .* stopped|so the query-level .* stopped/);
      expect(line).toMatch(/\.( Reconnect Google| Connect Search Console)?$/);
    }
  });

  it("names the next sync on every block while Google has returned nothing", () => {
    const at = nextSyncClock();
    const lines = restatedBlocks({ connected: true, needsReconnect: false });
    expect(lines).toEqual([
      `Google is connected. Clicks and impressions arrive after the next sync${at ? `, at ${at}` : ""}.`,
      `Google is connected. Clicks per page arrive after the next sync${at ? `, at ${at}` : ""}.`,
      `Google is connected. Positions per search arrive after the next sync${at ? `, at ${at}` : ""}.`,
    ]);
  });

  it("gives only the block that asks for it the link", () => {
    const [perf, best, cannibal] = restatedBlocks({ connected: true, needsReconnect: true });
    expect(perf).toBe("Google refused the saved sign-in, so clicks and impressions stopped at the last sync. Reconnect Google");
    expect(best).toBe("Google refused the saved sign-in, so clicks per page stopped at the last sync.");
    expect(cannibal).toBe("Google refused the saved sign-in, so positions per search stopped at the last sync.");
  });
});

describe("the full no-rows prompt", () => {
  it("leads with the next sync instead of a first sync that may already have run", () => {
    const at = nextSyncClock();
    const html = text(renderToStaticMarkup(<GscGate connected hasData={false}><p>data</p></GscGate>));
    expect(html.startsWith(`Google is connected. The first numbers arrive after the next sync${at ? `, at ${at}` : ""}.`)).toBe(true);
    expect(html).not.toContain("The first sync runs at");
    expect(html).not.toContain("data");
  });
});

describe("DataFreshness", () => {
  const base = { connected: true, needsReconnect: false, lastSyncError: null, latestMetricDate: null, siteUrl: null } as unknown as SyncHealth;

  it("says a fresh connection has not synced, not that it 'synced never'", () => {
    const line = text(renderToStaticMarkup(<DataFreshness health={{ ...base, lastSyncAt: null } as SyncHealth} />));
    expect(line).toMatch(/^Search Console has not synced yet/);
    expect(line).not.toContain("synced never");
  });

  it("keeps the relative time once a sync has run", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const line = text(renderToStaticMarkup(<DataFreshness health={{ ...base, lastSyncAt: "2026-10-20T09:00:00Z" } as SyncHealth} now={now} />));
    expect(line).toMatch(/^Search Console synced 3 hours ago/);
  });
});

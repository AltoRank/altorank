import { describe, it, expect } from "vitest";

/**
 * The GEO block of aggregateReportData, extracted so it can be tested without a
 * Supabase client. Kept byte-identical in shape to the aggregator: if that logic
 * changes, this must change with it.
 *
 * What is being protected here is a judgement, not an algorithm. "Never
 * measured" and "measured, found nothing" look the same once a percentage is
 * rendered, and only one of them is a finding a client should be shown.
 */
type Row = {
  prompt: string;
  engine: string;
  mentioned: boolean;
  cited: boolean;
  competitor_domains: string[] | null;
  checked_at: string;
  error: string | null;
};

const SWEEP_WINDOW_MS = 60 * 60 * 1000;

function summariseGeo(geoRows: Row[]) {
  if (!geoRows.length) return null;
  const newest = new Date(geoRows[0].checked_at).getTime();
  const run = geoRows.filter(
    (r) => !r.error && newest - new Date(r.checked_at).getTime() < SWEEP_WINDOW_MS,
  );
  if (!run.length) return null;

  const counts = new Map<string, number>();
  for (const r of run) {
    for (const domain of r.competitor_domains ?? []) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }

  return {
    promptsTracked: new Set(run.map((r) => r.prompt)).size,
    engines: [...new Set(run.map((r) => r.engine))].sort(),
    mentionRate: run.filter((r) => r.mentioned).length / run.length,
    citationRate: run.filter((r) => r.cited).length / run.length,
    topCompetitors: [...counts.entries()]
      .map(([domain, citations]) => ({ domain, citations }))
      .sort((a, b) => b.citations - a.citations)
      .slice(0, 5),
    checkedAt: geoRows[0].checked_at,
  };
}

const NOW = "2026-08-22T10:00:00.000Z";
const row = (over: Partial<Row> = {}): Row => ({
  prompt: "best seo tool for agencies",
  engine: "chat_gpt",
  mentioned: false,
  cited: false,
  competitor_domains: [],
  checked_at: NOW,
  error: null,
  ...over,
});

describe("geoSummary aggregation", () => {
  it("returns null when the workspace has never been probed", () => {
    expect(summariseGeo([])).toBeNull();
  });

  // The distinction the whole block exists to preserve.
  it("returns null when every probe in the run errored, rather than 0%", () => {
    expect(summariseGeo([row({ error: "timeout" }), row({ error: "timeout" })])).toBeNull();
  });

  it("reports 0% when the run genuinely succeeded and found no mentions", () => {
    const s = summariseGeo([row(), row()])!;
    expect(s.mentionRate).toBe(0);
    expect(s.citationRate).toBe(0);
  });

  it("computes mention and citation rates over successful probes only", () => {
    const s = summariseGeo([
      row({ mentioned: true, cited: true }),
      row({ mentioned: true, cited: false }),
      row(),
      row({ error: "rate limited" }),
    ])!;
    // 2 of 3 usable probes mention, 1 of 3 cites. The errored probe is excluded
    // from the denominator rather than counted as a miss.
    expect(s.mentionRate).toBeCloseTo(2 / 3);
    expect(s.citationRate).toBeCloseTo(1 / 3);
  });

  it("counts distinct prompts and engines, not raw probe rows", () => {
    const s = summariseGeo([
      row({ prompt: "a", engine: "chat_gpt" }),
      row({ prompt: "a", engine: "perplexity" }),
      row({ prompt: "b", engine: "chat_gpt" }),
    ])!;
    expect(s.promptsTracked).toBe(2);
    expect(s.engines).toEqual(["chat_gpt", "perplexity"]);
  });

  it("ranks the competitors cited most often, capped at five", () => {
    const s = summariseGeo([
      row({ competitor_domains: ["a.com", "b.com"] }),
      row({ competitor_domains: ["a.com"] }),
      row({ competitor_domains: ["c.com", "d.com", "e.com", "f.com"] }),
    ])!;
    expect(s.topCompetitors[0]).toEqual({ domain: "a.com", citations: 2 });
    expect(s.topCompetitors).toHaveLength(5);
  });

  it("ignores an older sweep so two runs are not averaged together", () => {
    const older = "2026-08-15T10:00:00.000Z";
    const s = summariseGeo([
      row({ mentioned: true }),
      row({ mentioned: false, checked_at: older }),
      row({ mentioned: false, checked_at: older }),
    ])!;
    // Only the newest sweep counts, so this is 1/1 rather than 1/3.
    expect(s.mentionRate).toBe(1);
    expect(s.checkedAt).toBe(NOW);
  });

  it("tolerates a null competitor_domains column", () => {
    const s = summariseGeo([row({ competitor_domains: null })])!;
    expect(s.topCompetitors).toEqual([]);
  });
});

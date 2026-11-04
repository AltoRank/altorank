import { describe, it, expect } from "vitest";
import { geoReportSummary, type GeoResultRow, type GeoRun } from "@/lib/geo/read";

/**
 * The GEO block of the client report (lib/geo/read.ts, geoReportSummary),
 * which aggregateReportData calls with the latest sweep.
 *
 * What is being protected here is a judgement, not an algorithm. "Never
 * measured" and "measured, found nothing" look the same once a percentage is
 * rendered, and only one of them is a finding a client should be shown.
 */
const NOW = "2026-08-22T10:00:00.000Z";

const run = (over: Partial<GeoRun> = {}): GeoRun => ({
  id: "run-1",
  workspace_id: "ws-1",
  status: "complete",
  planned: 4,
  captured: 4,
  failed: 0,
  settings: {
    surfaces: ["chat_gpt"],
    samples: 1,
    prompts: [],
    languageCode: "en",
    locationCode: 2840,
    brandName: "AltoRank",
    brandDomain: "altorank.co",
  },
  cost_usd: 0,
  started_at: NOW,
  finished_at: NOW,
  ...over,
});

let n = 0;
const row = (over: Partial<GeoResultRow> = {}): GeoResultRow => ({
  id: `r${n++}`,
  workspace_id: "ws-1",
  run_id: "run-1",
  sample: 1,
  prompt: "best seo tool for agencies",
  engine: "chat_gpt",
  surface: "app",
  status: "ok",
  model: "gpt",
  answer: "",
  mentioned: false,
  cited: false,
  citations: [],
  competitor_domains: [],
  brands: [],
  fan_out_queries: [],
  cost_usd: 0.0012,
  error: null,
  checked_at: NOW,
  ...over,
});

const summarise = (rows: GeoResultRow[], r: GeoRun = run()) => geoReportSummary({ run: r, rows });

describe("geoReportSummary", () => {
  it("returns null when the workspace has never been measured", () => {
    expect(geoReportSummary(null)).toBeNull();
  });

  // The distinction the whole block exists to preserve.
  it("returns null when every sample in the run failed, rather than 0%", () => {
    expect(summarise([row({ status: "failed", error: "timeout" }), row({ status: "failed", error: "timeout" })])).toBeNull();
  });

  it("returns null while the only samples are still queued", () => {
    expect(summarise([row({ status: "pending" })], run({ status: "running" }))).toBeNull();
  });

  it("reports 0% when the run genuinely succeeded and found no mentions", () => {
    const s = summarise([row(), row()])!;
    expect(s.mentionRate).toBe(0);
    expect(s.citationRate).toBe(0);
  });

  it("computes mention and citation rates over collected answers only", () => {
    const s = summarise([
      row({ mentioned: true, cited: true }),
      row({ mentioned: true, cited: false }),
      row(),
      row({ status: "failed", error: "rate limited" }),
      row({ status: "pending" }),
    ])!;
    // 2 of 3 answers mention, 1 of 3 cites. The failed and queued samples are
    // excluded from the denominator rather than counted as misses.
    expect(s.mentionRate).toBeCloseTo(2 / 3);
    expect(s.citationRate).toBeCloseTo(1 / 3);
  });

  it("counts distinct prompts and engines, not raw rows", () => {
    const s = summarise([
      row({ prompt: "a", engine: "chat_gpt" }),
      row({ prompt: "a", engine: "google_ai_mode" }),
      row({ prompt: "b", engine: "chat_gpt" }),
    ])!;
    expect(s.promptsTracked).toBe(2);
    expect(s.engines).toEqual(["chat_gpt", "google_ai_mode"]);
  });

  it("ranks the domains cited most often, capped at five", () => {
    const s = summarise([
      row({ competitor_domains: ["a.com", "b.com"] }),
      row({ competitor_domains: ["a.com"] }),
      row({ competitor_domains: ["c.com", "d.com", "e.com", "f.com"] }),
    ])!;
    expect(s.topCompetitors[0]).toEqual({ domain: "a.com", citations: 2 });
    expect(s.topCompetitors).toHaveLength(5);
  });

  it("dates the summary by when the sweep finished", () => {
    const s = summarise([row()], run({ started_at: "2026-08-15T08:00:00.000Z", finished_at: NOW }))!;
    expect(s.checkedAt).toBe(NOW);
  });

  it("tolerates a null competitor_domains column", () => {
    const s = summarise([row({ competitor_domains: null as unknown as string[] })])!;
    expect(s.topCompetitors).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A qualifying call (the cron, the onboarding planner) needs a business
 * profile to judge against. Our own two workspaces had none, and every term
 * came back "pending: could not be confirmed" for six nights. Now the profile
 * is read off the site first, and when that fails the recommendations say
 * exactly that instead of spending on verdicts that cannot succeed.
 */

const ensure = vi.fn();
const qualify = vi.fn();
vi.mock("@/lib/keyword-research/business-context", () => ({ ensureBusinessProfile: (...a: unknown[]) => ensure(...a) }));
vi.mock("@/lib/keyword-research/opportunity", async () => {
  const real = await vi.importActual<typeof import("@/lib/keyword-research/opportunity")>("@/lib/keyword-research/opportunity");
  return { ...real, qualifyOpportunities: (...a: unknown[]) => qualify(...a) };
});

import { recommendKeywords } from "../recommendations";
import { buildTopicalProfile } from "../topical-profile";
import type { CrawlResult } from "@/lib/audit/crawler";

const page = (over: Partial<CrawlResult>): CrawlResult => ({
  url: "https://altorank.co/", status: 200, title: "", metaDescription: "", h1: [], h2: [], images: [], links: [], loadTimeMs: 0, ...over,
});
const PROFILE = buildTopicalProfile("altorank.co", [
  page({ title: "SEO content tools for agencies | AltoRank", h1: ["SEO content writing tools"], h2: ["Content marketing SEO", "SEO services"] }),
  page({ title: "Freelance SEO", h1: ["SEO content agency"] }),
], "2026-09-15T00:00:00.000Z");

function client(businessProfile: unknown): SupabaseClient {
  const rows = [
    { id: "a", term: "seo content writing tools", volume: 1300, difficulty: 20, source_type: "profile", source_ref: null },
    { id: "b", term: "content marketing seo", volume: 880, difficulty: 15, source_type: "profile", source_ref: null },
  ];
  const chain = (value: unknown): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["eq", "in", "order", "gte", "not", "select", "is"]) self[m] = () => Object.assign(Promise.resolve(value), self);
    self.single = async () => ({ data: { topical_profile: PROFILE, dr: 10, business_profile: businessProfile, domain: "altorank.co", language: "en", location_code: 2840 } });
    return self;
  };
  return {
    from: (table: string) => chain(table === "keywords" ? { data: rows.map((r) => ({ ...r, intent: "commercial", status: "new", source: null })) } : { data: [] }),
  } as unknown as SupabaseClient;
}

const DESCRIBED = { description: "AltoRank writes SEO articles agencies approve before publishing.", audiences: ["SEO agencies"], competitors: [] };

beforeEach(() => {
  ensure.mockReset();
  qualify.mockReset().mockResolvedValue(new Map());
});

describe("recommendKeywords with qualify", () => {
  it("reads the site for a profile before buying any verdict, and judges against what it found", async () => {
    ensure.mockResolvedValue({ business: DESCRIBED, inferred: true, missing: null });
    await recommendKeywords(client(null), "ws", { qualify: true });
    expect(ensure).toHaveBeenCalledWith(expect.anything(), "ws", "altorank.co", null);
    expect(qualify).toHaveBeenCalledOnce();
    const context = qualify.mock.calls[0][3] as { business: unknown };
    expect(context.business).toEqual(DESCRIBED);
  });

  it("does not read the site when the profile is already usable, and does not touch it without qualify", async () => {
    ensure.mockResolvedValue({ business: DESCRIBED, inferred: false, missing: null });
    await recommendKeywords(client(DESCRIBED), "ws", { qualify: true });
    expect(ensure).toHaveBeenCalledWith(expect.anything(), "ws", "altorank.co", DESCRIBED);
    ensure.mockClear();
    await recommendKeywords(client(null), "ws");
    expect(ensure).not.toHaveBeenCalled();
    expect(qualify).toHaveBeenCalledOnce();
  });

  it("with no profile and an unreadable site, skips every term and says so, buying nothing", async () => {
    ensure.mockResolvedValue({ business: null, inferred: false, missing: "no business profile, and the site could not be read to build one" });
    const recs = await recommendKeywords(client(null), "ws", { qualify: true });
    expect(qualify).not.toHaveBeenCalled();
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.action).toBe("skip");
      expect(r.opportunity).toMatchObject({ status: "pending", cause: "no_profile" });
      expect(r.reasons[0]).toBe("Topic qualification is blocked: no business profile, and the site could not be read to build one.");
    }
  });
});

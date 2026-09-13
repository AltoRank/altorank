import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const { qualify } = vi.hoisted(() => ({ qualify: vi.fn() }));
vi.mock("@/lib/keyword-research/opportunity", async (original) => ({ ...await original<object>(), qualifyOpportunities: qualify }));
import { scheduleKeywords } from "../plan";

const writes: Array<{ table: string; value: unknown }> = [];
const scopes: string[] = [];
function client() {
  return { from(table: string) {
    const data = table === "workspaces" ? { domain: "example.com", language: "Italian", location_code: 2380, auto_generate_weekly_limit: 7, business_profile: { offerings: ["clinic websites"] } }
      : table === "keywords" ? [{ id: "yes", term: "clinic website costs" }, { id: "no", term: "ups tracking" }] : [];
    const q = {
      select: () => q, eq: (field: string, value: string) => { if (field === "workspace_id") scopes.push(value); return q; }, in: () => q,
      maybeSingle: async () => ({ data, error: null }),
      insert: (value: unknown) => { writes.push({ table, value }); return q; },
      update: (value: unknown) => { writes.push({ table, value }); return q; },
      then: (resolve: (value: unknown) => unknown) => resolve({ data, error: null }),
    };
    return q;
  } } as unknown as SupabaseClient;
}
beforeEach(() => { vi.clearAllMocks(); writes.length = 0; scopes.length = 0; });
describe("research scheduling qualification", () => {
  it("schedules only approved topics and returns the specific refusal", async () => {
    qualify.mockResolvedValue(new Map([["yes", { status: "qualified", organicUrls: [] }], ["no", { status: "rejected", reason: "Carrier navigation" }]]));
    const result = await scheduleKeywords(client(), "workspace", ["yes", "no"]);
    expect(result.scheduled.map((row) => row.keywordId)).toEqual(["yes"]);
    expect(result.reasons?.no).toBe("Carrier navigation");
    expect(writes[0]).toMatchObject({ table: "calendar_entries", value: [{ workspace_id: "workspace", keyword_id: "yes" }] });
    expect(qualify.mock.calls[0][3]).toMatchObject({ languageCode: "it", locationCode: 2380, business: { offerings: ["clinic websites"] } });
    expect(scopes.every((scope) => scope === "workspace")).toBe(true);
  });
  it("creates no schedule when all decisions are absent", async () => {
    qualify.mockResolvedValue(new Map());
    const result = await scheduleKeywords(client(), "workspace", ["yes", "no"]);
    expect(result.scheduled).toEqual([]);
    expect(result.refused).toEqual(["yes", "no"]);
    expect(writes).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

// ---------------------------------------------------------------------------
// syncBingWorkspace: a stored Bing site is read only while it is the site's
// ---------------------------------------------------------------------------

const listBingSites = vi.fn();
const fetchBingDailyTraffic = vi.fn();
vi.mock("../webmaster", async (importOriginal) => {
  const real = await importOriginal<typeof import("../webmaster")>();
  return {
    ...real,
    listBingSites: (...args: unknown[]) => listBingSites(...args),
    fetchBingDailyTraffic: (...args: unknown[]) => fetchBingDailyTraffic(...args),
  };
});
vi.mock("@/lib/crypto", () => ({ decrypt: () => JSON.stringify({ apiKey: "k" }) }));

const { syncBingWorkspace } = await import("../sync");

function db(config: Record<string, unknown>) {
  return fakeSupabase({
    workspace_integrations: [{ id: "wi-1", workspace_id: "ws-1", integration_id: "bing", config }],
    analytics_metrics: [],
  });
}

function run(supabase: ReturnType<typeof db>, bingSiteUrl: string | undefined, domain = "acme.co") {
  return syncBingWorkspace(
    supabase as unknown as SupabaseClient,
    { id: "wi-1", tokens: { encrypted: "x" }, config: bingSiteUrl ? { bingSiteUrl } : {}, workspace: { id: "ws-1", domain } },
    7,
  );
}

beforeEach(() => {
  listBingSites.mockReset();
  fetchBingDailyTraffic.mockReset();
  listBingSites.mockResolvedValue([
    { url: "https://acme.co/", isVerified: true },
    { url: "https://client-b.example/", isVerified: true },
  ]);
  fetchBingDailyTraffic.mockResolvedValue([]);
});

describe("syncBingWorkspace", () => {
  it("uses a stored site that belongs to the workspace's domain", async () => {
    const supabase = db({ bingSiteUrl: "https://www.acme.co/" });
    const out = await run(supabase, "https://www.acme.co/");
    expect(out.error).toBeUndefined();
    expect(listBingSites).not.toHaveBeenCalled();
    expect(fetchBingDailyTraffic).toHaveBeenCalledWith("k", "https://www.acme.co/");
  });

  it("ignores a stored site of another domain and resolves the workspace's own", async () => {
    const supabase = db({ bingSiteUrl: "https://client-b.example/" });
    const out = await run(supabase, "https://client-b.example/");
    expect(out.error).toBeUndefined();
    expect(fetchBingDailyTraffic).toHaveBeenCalledWith("k", "https://acme.co/");
    expect(fetchBingDailyTraffic).not.toHaveBeenCalledWith("k", "https://client-b.example/");
    expect(supabase.tables.workspace_integrations[0].config).toMatchObject({ bingSiteUrl: "https://acme.co/" });
  });

  it("does not read a stored site whose text only contains the domain", async () => {
    for (const stored of ["https://client-b.example/?.acme.co", "https://client-b.example#.acme.co", "https://acme.co@client-b.example/"]) {
      fetchBingDailyTraffic.mockClear();
      await run(db({ bingSiteUrl: stored }), stored);
      expect(fetchBingDailyTraffic).toHaveBeenCalledWith("k", "https://acme.co/");
    }
  });
});

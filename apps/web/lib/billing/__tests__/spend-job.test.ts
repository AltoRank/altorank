import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// provider_spend.job says which work bought a row, so Operations files each
// row under the cron that spent it instead of guessing from the provider
// (every model call was filed under the nightly writer, refresh and setup
// included). Pinned: a cron's calls carry its name, an inner scope inherits
// it, and a database without the column still gets the row.

vi.mock("@/lib/observability/record", () => ({ recordEvent: vi.fn(async () => undefined) }));

const { recordSpend } = await import("../spend");
const { withSpendScope } = await import("../spend-scope");
const { observedCron } = await import("@/lib/observability/cron");

function db(opts: { knows?: string[] } = {}) {
  const knows = new Set(opts.knows ?? ["stage", "job"]);
  const tries: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        tries.push({ ...row });
        const unknown = ["stage", "job"].find((c) => c in row && !knows.has(c));
        return unknown ? { error: { message: `Could not find the '${unknown}' column of 'provider_spend' in the schema cache` } } : { error: null };
      },
    }),
  } as unknown as SupabaseClient;
  return { client, tries };
}

describe("provider_spend.job", () => {
  it("is the cron's own name for every call its run makes, inner scopes included", async () => {
    const { client, tries } = db();
    const handler = observedCron("cron.refresh", async () => {
      await withSpendScope({ workspaceId: "ws-1" }, () => recordSpend(client, { provider: "anthropic", operation: "claude-sonnet-5", costUsd: 0.1 }));
      return Response.json({ ok: true });
    });
    await handler(new Request("http://localhost/api/cron/refresh"));
    expect(tries).toEqual([expect.objectContaining({ job: "cron.refresh", workspace_id: "ws-1" })]);
  });

  it("is what the entry says when it says so", async () => {
    const { client, tries } = db();
    await withSpendScope({ job: "cron.generate" }, () => recordSpend(client, { provider: "anthropic", operation: "x", job: "editor" }));
    expect(tries[0].job).toBe("editor");
  });

  it("is left off, and the row still written, on a database without the column", async () => {
    const { client, tries } = db({ knows: ["stage"] });
    await withSpendScope({ job: "onboarding" }, () => recordSpend(client, { provider: "anthropic", operation: "x", stage: "profile" }));
    expect(tries).toHaveLength(2);
    expect(tries[1]).not.toHaveProperty("job");
    expect(tries[1].stage).toBe("profile");
  });

  it("drops both tags on a database that knows neither", async () => {
    const { client, tries } = db({ knows: [] });
    await withSpendScope({ job: "onboarding" }, () => recordSpend(client, { provider: "anthropic", operation: "x", stage: "profile" }));
    expect(tries).toHaveLength(3);
    expect(tries[2]).not.toHaveProperty("job");
    expect(tries[2]).not.toHaveProperty("stage");
  });

  it("is absent outside any job", async () => {
    const { client, tries } = db();
    await recordSpend(client, { provider: "anthropic", operation: "x" });
    expect(tries[0]).not.toHaveProperty("job");
  });
});

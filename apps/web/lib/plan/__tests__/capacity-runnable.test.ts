import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import { getPlanCapacity } from "../capacity";

// A scheduled improvement holds a plan slot only when cron/refresh can run it.
// With scheduled rewrites off (the default) or no weekday picked, it never
// runs, and counting it took room from the article plan for nothing.

function db(ws: Record<string, unknown>) {
  return fakeSupabase({
    workspaces: [{ id: "ws1", auto_generate_weekly_limit: 7, refresh_enabled: true, refresh_days: [2], ...ws }],
    calendar_entries: [
      { id: "e1", workspace_id: "ws1", status: "queue" },
      { id: "e2", workspace_id: "ws1", status: "scheduled" },
    ],
    refresh_tasks: [
      { id: "t1", workspace_id: "ws1", status: "scheduled" },
      { id: "t2", workspace_id: "ws1", status: "running" },
      { id: "t3", workspace_id: "ws1", status: "done" },
    ],
  }) as unknown as SupabaseClient;
}

describe("getPlanCapacity", () => {
  it("counts scheduled and running improvements while rewrites can run", async () => {
    const c = await getPlanCapacity(db({}), "ws1");
    expect(c).toMatchObject({ articles: 2, improvements: 2, scheduled: 4 });
  });

  it("counts none with scheduled rewrites off", async () => {
    const c = await getPlanCapacity(db({ refresh_enabled: false }), "ws1");
    expect(c).toMatchObject({ articles: 2, improvements: 0, scheduled: 2 });
  });

  it("counts none with no weekday picked", async () => {
    const c = await getPlanCapacity(db({ refresh_days: [] }), "ws1");
    expect(c).toMatchObject({ improvements: 0, scheduled: 2 });
  });
});

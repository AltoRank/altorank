import { describe, it, expect, afterEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountCountingClient, resetAccountCountingClient } from "../account-client";

const created: Array<[string, string]> = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => {
    created.push([url, key]);
    return { __service: true } as unknown as SupabaseClient;
  },
}));

const caller = { __caller: true } as unknown as SupabaseClient;

afterEach(() => {
  resetAccountCountingClient();
  created.length = 0;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

describe("accountCountingClient", () => {
  it("counts with the service role, not the caller's RLS scope", () => {
    // The whole point: a member with `workspace_ids` set sees a slice of the
    // account, and counting the account through that slice handed them the
    // whole allowance again (verified 2026-09-06: owner 100/100, scoped
    // editor on the same account 0/100).
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54331";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    const client = accountCountingClient(caller);
    expect(client).not.toBe(caller);
    expect(created).toEqual([["http://localhost:54331", "service-role"]]);
  });

  it("memoises, so a request that asks twice opens one client", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54331";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    expect(accountCountingClient(caller)).toBe(accountCountingClient(caller));
    expect(created).toHaveLength(1);
  });

  it("falls back to the caller when there is no service role key", () => {
    // A self-hosted install that never set one keeps exactly today's
    // behaviour rather than crashing on a billing read.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54331";
    expect(accountCountingClient(caller)).toBe(caller);
    expect(created).toHaveLength(0);
  });
});

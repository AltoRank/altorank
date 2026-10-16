import { describe, it, expect } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { uniqueSlug } from "../unique-slug";

// A blog-API site serves articles by slug, so a new article never takes a
// slug another article on the same site already has.

const db = fakeSupabase({
  articles: [
    { id: "a1", workspace_id: "ws-1", slug: "best-crm" },
    { id: "a2", workspace_id: "ws-1", slug: "best-crm-2" },
    { id: "a3", workspace_id: "ws-1", slug: "best-crm-tools" },
    { id: "b1", workspace_id: "ws-2", slug: "seo-audit" },
  ],
}) as unknown as SupabaseClient;

describe("uniqueSlug", () => {
  it("keeps a slug nobody on the site has", async () => {
    expect(await uniqueSlug(db, "ws-1", "seo-audit")).toBe("seo-audit");
  });

  it("suffixes the first free number when the slug is taken", async () => {
    expect(await uniqueSlug(db, "ws-1", "best-crm")).toBe("best-crm-3");
  });

  it("only looks at the same site", async () => {
    expect(await uniqueSlug(db, "ws-2", "best-crm")).toBe("best-crm");
  });

  it("falls back to the slug as given when the read fails", async () => {
    const broken = { from: () => { throw new Error("down"); } } as unknown as SupabaseClient;
    expect(await uniqueSlug(broken, "ws-1", "best-crm")).toBe("best-crm");
  });
});

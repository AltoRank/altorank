import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

/**
 * The headless blog API serves live articles to a customer's own site. An
 * article the nightly check found live on that site (migration 094) is
 * already there, at the address the customer published it at by hand; the
 * API must not serve it a second time at our slug.
 */
const sb = fakeSupabase({
  articles: [
    {
      id: "a-pushed", workspace_id: "ws-1", slug: "published-here", title: "Published through AltoRank", status: "live",
      published_at: "2026-09-20T10:00:00Z", found_on_site_at: null, content: { type: "doc", content: [] },
    },
    {
      id: "a-found", workspace_id: "ws-1", slug: "found-there", title: "Found on the site", status: "live",
      published_at: "2026-09-22T10:48:00Z", found_on_site_at: "2026-09-23T10:00:00Z", content: { type: "doc", content: [] },
    },
  ],
});

vi.mock("@/lib/blog-api/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/blog-api/auth")>();
  return {
    ...real,
    authenticateBlogRequest: async () => ({ ok: true, supabase: sb, workspaceId: "ws-1", domain: "acme-agency.example" }),
  };
});

import { GET as list } from "../route";
import { GET as one } from "../[slug]/route";

const req = (path: string) => new Request(`https://app.example/api/blog/v1/articles${path}?workspace_id=ws-1`);

describe("blog API and articles found on the customer's site", () => {
  it("lists only what went out through AltoRank", async () => {
    const body = await (await list(req(""))).json();
    expect(body.articles.map((a: { slug: string }) => a.slug)).toEqual(["published-here"]);
    expect(body.total).toBe(1);
  });

  it("does not serve a found article by its slug", async () => {
    expect((await one(req("/found-there"), { params: Promise.resolve({ slug: "found-there" }) })).status).toBe(404);
    expect((await one(req("/published-here"), { params: Promise.resolve({ slug: "published-here" }) })).status).toBe(200);
  });
});

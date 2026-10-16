import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

/**
 * A site reading the blog API gets the body a CMS publish would send: no
 * second H1 under the page's own title, the dateline, and the structured
 * data (as its own field, for the site to put in a script tag) - not the bare
 * document rendered to HTML.
 */
const doc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "How to pick a CRM" }] },
    { type: "paragraph", content: [{ type: "text", text: "Start with the pipeline you already run." }] },
  ],
};

const sb = fakeSupabase({
  articles: [
    {
      id: "a-1", workspace_id: "ws-1", slug: "pick-a-crm", title: "How to pick a CRM", status: "live",
      meta_description: "A short guide.", featured_image_url: null, keyword: "pick a crm",
      published_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:00:00Z", found_on_site_at: null, content: doc,
    },
  ],
  workspaces: [{ id: "ws-1", account_id: "acc-1", domain: "acme-agency.example", language: "en", business_profile: { name: "Acme" }, indexnow_key: null }],
  workspace_output_settings: [{ workspace_id: "ws-1", faq_schema: false }],
});

let reason: "no-plan" | "plan" = "plan";
vi.mock("@/lib/billing/quota", () => ({ getQuota: async () => ({ reason }) }));
vi.mock("@/lib/publishing/attribution", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/publishing/attribution")>();
  return { ...real, isOperatorAccount: async () => false };
});
vi.mock("@/lib/blog-api/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/blog-api/auth")>();
  return {
    ...real,
    authenticateBlogRequest: async () => ({ ok: true, supabase: sb, workspaceId: "ws-1", domain: "acme-agency.example", keyKind: "blog" }),
  };
});

import { GET } from "../[slug]/route";

const get = async () =>
  (await (await GET(new Request("https://app.example/api/blog/v1/articles/pick-a-crm?workspace_id=ws-1"), {
    params: Promise.resolve({ slug: "pick-a-crm" }),
  })).json()) as { article: { content_html: string; structured_data: Array<Record<string, unknown>> } };

describe("blog API article body", () => {
  it("drops the H1 that repeats the title and carries the dateline", async () => {
    const { article } = await get();
    expect(article.content_html).not.toContain("<h1");
    expect(article.content_html).toContain("Start with the pipeline");
    expect(article.content_html).toContain("September 20, 2026");
  });

  it("returns the BlogPosting JSON-LD as its own field, not inside the body", async () => {
    const { article } = await get();
    expect(article.structured_data.some((s) => s["@type"] === "BlogPosting")).toBe(true);
    expect(article.content_html).not.toContain("application/ld+json");
  });

  it("adds the free tier's attribution, like a CMS publish", async () => {
    reason = "no-plan";
    const { article } = await get();
    expect(article.content_html).toContain("data-altorank-attribution");
    reason = "plan";
  });
});

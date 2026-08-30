import { describe, it, expect, vi } from "vitest";

// Mock the CMS modules before importing core
vi.mock("@/lib/cms/adapter", () => ({
  resolveCMSAdapter: vi.fn(),
}));
vi.mock("@/lib/cms/html", () => ({
  tiptapToHtml: vi.fn(() => "<p>Hello world</p>"),
}));

import { publishArticleCore } from "../core";
import { resolveCMSAdapter } from "@/lib/cms/adapter";

function mockSupabase(overrides: {
  article?: Record<string, unknown> | null;
  articleError?: { message: string } | null;
  integrations?: Record<string, unknown>[] | null;
  updateError?: { message: string } | null;
}) {
  const {
    article = {
      id: "a1",
      workspace_id: "w1",
      status: "approved",
      approved_by: "u1",
      title: "Test",
      slug: "test",
      content: { type: "doc", content: [] },
      cms: "wordpress",
      meta_description: null,
    },
    articleError = null,
    integrations = [
      {
        id: "wi1",
        config: { type: "wordpress", siteUrl: "https://example.com", username: "admin", applicationPassword: "pw" },
        integration: { tag: "CMS" },
      },
    ],
    updateError = null,
  } = overrides;

  return {
    from: vi.fn((table: string) => {
      if (table === "articles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: article, error: articleError }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: updateError }),
          }),
        };
      }
      if (table === "workspace_integrations") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: integrations }),
          }),
        };
      }
      return {};
    }),
  };
}

describe("publishArticleCore", () => {
  it("publishes an article through the CMS adapter", async () => {
    const mockPublish = vi.fn().mockResolvedValue({
      externalId: "ext-123",
      url: "https://example.com/blog/test",
    });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: mockPublish,
    });

    const supabase = mockSupabase({});
    const result = await publishArticleCore(supabase as never, "a1");

    expect(result.externalId).toBe("ext-123");
    expect(result.url).toBe("https://example.com/blog/test");
    expect(mockPublish).toHaveBeenCalledOnce();
  });

  it("throws when article is not found", async () => {
    const supabase = mockSupabase({ article: null, articleError: { message: "not found" } });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(
      "Article not found",
    );
  });

  it("throws when article has no content", async () => {
    const supabase = mockSupabase({
      article: { id: "a1", workspace_id: "w1", content: null },
    });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(
      "Article has no content",
    );
  });

  it("throws when no CMS integration is connected", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn(),
    });
    const supabase = mockSupabase({ integrations: [] });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(
      "No CMS integration",
    );
  });

  it("throws on update failure", async () => {
    const mockPublish = vi.fn().mockResolvedValue({
      externalId: "ext-123",
      url: "https://example.com/blog/test",
    });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: mockPublish,
    });

    const supabase = mockSupabase({ updateError: { message: "db error" } });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(
      "db error",
    );
  });

  it("throws when the article is not approved (the gate)", async () => {
    const supabase = mockSupabase({
      article: {
        id: "a1",
        workspace_id: "w1",
        content: { type: "doc", content: [] },
        status: "review",
      },
    });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(
      "must be approved before publishing",
    );
  });

  it("publishes a scheduled article only when it carries a recorded approval", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn().mockResolvedValue({ externalId: "ext-1", url: "https://x/y" }),
    });
    // Legacy scheduled row (approved_by null) must NOT publish.
    const legacy = mockSupabase({
      article: {
        id: "a1",
        workspace_id: "w1",
        content: { type: "doc", content: [] },
        status: "scheduled",
        approved_by: null,
      },
    });
    await expect(publishArticleCore(legacy as never, "a1")).rejects.toThrow(
      "must be approved before publishing",
    );
    // Properly scheduled row (approved_by set) publishes.
    const ok = mockSupabase({
      article: {
        id: "a1",
        workspace_id: "w1",
        content: { type: "doc", content: [] },
        status: "scheduled",
        approved_by: "u1",
      },
    });
    const result = await publishArticleCore(ok as never, "a1");
    expect(result.externalId).toBe("ext-1");
  });
});

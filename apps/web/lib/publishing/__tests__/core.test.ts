import { describe, it, expect, vi } from "vitest";

// Mock the CMS modules before importing core
vi.mock("@/lib/cms/adapter", () => ({
  resolveCMSAdapter: vi.fn(),
}));
vi.mock("@/lib/cms/html", () => ({
  tiptapToHtml: vi.fn(() => "<p>Hello world</p>"),
}));
vi.mock("@/lib/seo/indexing", () => ({
  submitForIndexing: vi.fn().mockResolvedValue({ indexnow: "submitted", google: "not-connected" }),
}));

import { publishArticleCore, PublishError } from "../core";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { submitForIndexing } from "@/lib/seo/indexing";

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

  // ---------------------------------------------------------------------------
  // Publish mode and retry safety
  // ---------------------------------------------------------------------------

  it("passes the connection's publish mode to the adapter and reports it back", async () => {
    const mockPublish = vi.fn().mockResolvedValue({ externalId: "ext-1", url: "https://example.com/blog/test" });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish: mockPublish });

    const supabase = mockSupabase({
      integrations: [
        {
          id: "wi1",
          publish_mode: "draft",
          config: { type: "wordpress", siteUrl: "https://example.com", username: "admin", applicationPassword: "pw" },
          integration: { tag: "CMS" },
        },
      ],
    });
    const result = await publishArticleCore(supabase as never, "a1");

    expect(mockPublish.mock.calls[0][0]).toMatchObject({ publishMode: "draft" });
    expect(result).toMatchObject({ destinationId: "wi1", publishMode: "draft" });
  });

  /**
   * The base mock returns {} for `workspaces`, which makes the indexing path
   * throw into its catch before submitting anything - so on its own it cannot
   * tell "skipped on purpose" from "fell over". This one answers the
   * workspace lookups, so a live publish really reaches submitForIndexing and
   * a draft's absence there means something.
   */
  function mockSupabaseWithWorkspace(publishMode: "draft" | "publish") {
    const base = mockSupabase({
      integrations: [
        { id: "wi1", publish_mode: publishMode, config: { type: "wordpress" }, integration: { tag: "CMS" } },
      ],
    });
    const inner = base.from;
    base.from = vi.fn((table: string) => {
      if (table === "workspaces") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { agency_id: null, indexnow_key: "k" } }),
            }),
          }),
        };
      }
      return inner(table);
    });
    return base;
  }

  it("a live publish submits the URL for indexing", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn().mockResolvedValue({ externalId: "ext-1", url: "https://example.com/blog/test" }),
    });
    vi.mocked(submitForIndexing).mockClear();
    await publishArticleCore(mockSupabaseWithWorkspace("publish") as never, "a1");
    expect(submitForIndexing).toHaveBeenCalledOnce();
  });

  it("a draft publish stores the post but tells no search engine about it", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn().mockResolvedValue({ externalId: "ext-1", url: "" }),
    });
    vi.mocked(submitForIndexing).mockClear();
    const supabase = mockSupabaseWithWorkspace("draft");
    await publishArticleCore(supabase as never, "a1");

    expect(submitForIndexing).not.toHaveBeenCalled();
    // And an empty draft URL is stored as null, not as a link to nowhere.
    // Each from("articles") builds a fresh object, so find the one whose
    // update was actually called.
    const update = supabase.from.mock.results
      .map((r) => r.value?.update)
      .find((u) => u?.mock.calls.length > 0);
    expect(update.mock.calls[0][0]).toMatchObject({ published_url: null, external_id: "ext-1", status: "live" });
  });

  it("updates in place, never creating a second post, when the article already has an external id", async () => {
    const mockPublish = vi.fn();
    const mockUpdate = vi.fn().mockResolvedValue({ externalId: "ext-old", url: "https://example.com/blog/test" });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish: mockPublish, update: mockUpdate });

    const supabase = mockSupabase({
      article: {
        id: "a1", workspace_id: "w1", status: "approved", approved_by: "u1",
        title: "Test", slug: "test", content: { type: "doc", content: [] },
        cms: "wordpress", external_id: "ext-old", published_url: "https://example.com/blog/test",
      },
    });
    const result = await publishArticleCore(supabase as never, "a1");

    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith("ext-old", expect.objectContaining({ title: "Test" }));
    expect(result.externalId).toBe("ext-old");
  });

  it("refuses, rather than duplicating, when the post exists and the adapter cannot update", async () => {
    const mockPublish = vi.fn();
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish: mockPublish });

    const supabase = mockSupabase({
      article: {
        id: "a1", workspace_id: "w1", status: "approved", approved_by: "u1",
        title: "Test", slug: "test", content: { type: "doc", content: [] },
        cms: "wordpress", external_id: "ext-old", published_url: "https://example.com/blog/test",
      },
    });
    await expect(publishArticleCore(supabase as never, "a1")).rejects.toThrow(/already exists on wordpress/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("lets git publish again over an existing file, because its publish is an upsert by path", async () => {
    const mockPublish = vi.fn().mockResolvedValue({ externalId: "src/content/blog/test.md", url: "https://example.com/blog/test/" });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish: mockPublish });

    const supabase = mockSupabase({
      article: {
        id: "a1", workspace_id: "w1", status: "approved", approved_by: "u1",
        title: "Test", slug: "test", content: { type: "doc", content: [] },
        cms: "git", external_id: "src/content/blog/test.md", published_url: null,
      },
      integrations: [
        { id: "wi-git", config: { type: "git", provider: "github", token: "t", owner: "o", repo: "r", branch: "main", contentPath: "src/content/blog" }, integration: { tag: "CMS" } },
      ],
    });
    await publishArticleCore(supabase as never, "a1");
    expect(mockPublish).toHaveBeenCalledOnce();
  });

  it("wraps an adapter failure in a PublishError that names the connection, so a retry can reuse it", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({
      publish: vi.fn().mockRejectedValue(new Error("WordPress publish failed (500): boom")),
    });
    const supabase = mockSupabase({});
    const err = await publishArticleCore(supabase as never, "a1").catch((e) => e);

    expect(err).toBeInstanceOf(PublishError);
    expect(err.message).toBe("WordPress publish failed (500): boom");
    expect(err.context).toEqual({ destinationId: "wi1", publishMode: "publish" });
  });

  it("a failure before any destination is chosen is a plain Error", async () => {
    const supabase = mockSupabase({ integrations: [] });
    const err = await publishArticleCore(supabase as never, "a1").catch((e) => e);
    expect(err).not.toBeInstanceOf(PublishError);
  });
});

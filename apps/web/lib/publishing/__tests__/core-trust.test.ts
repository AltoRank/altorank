import { describe, it, expect, vi, beforeEach } from "vitest";

// What the publisher adds to a draft on the way out: no second H1, the first
// publish date kept across republishes, and a dateline on every article
// (lib/content/trust.ts, lib/content/on-page.ts).
// A real first article (2026-09-27, a physiotherapy clinic) shipped with its
// title repeated as an <h1> and no date anywhere.

vi.mock("@/lib/cms/adapter", () => ({ resolveCMSAdapter: vi.fn() }));
vi.mock("@/lib/cms/html", () => ({ tiptapToHtml: vi.fn(() => "<h1>Physio vs AT</h1><p>Hello world</p>") }));
vi.mock("@/lib/seo/indexing", () => ({ submitForIndexing: vi.fn().mockResolvedValue({ indexnow: "submitted", google: "not-connected" }) }));
vi.mock("@/lib/billing/body-lock", () => ({ workspaceTrialGate: async () => "open" }));
vi.mock("@/lib/articles/body-read", () => ({
  readVisibleArticle: async (client: { article: unknown }) => client.article,
}));

import { publishArticleCore } from "../core";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import type { PublishPayload } from "@/lib/cms/types";

function fake(article: Record<string, unknown>, workspace: Record<string, unknown> | null = { domain: "acme-physio.example", language: "en" }) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    article,
    updates,
    from: vi.fn((table: string) => {
      if (table === "articles") {
        return {
          update: (row: Record<string, unknown>) => {
            updates.push(row);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === "workspaces") {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: workspace, error: null }) }) }) };
      }
      if (table === "workspace_integrations") {
        return {
          select: () => ({
            eq: async () => ({
              data: [{ id: "wi1", config: { type: "wordpress", siteUrl: "https://acme-physio.example", username: "u", applicationPassword: "p" }, integration: { tag: "CMS" } }],
            }),
          }),
        };
      }
      return {};
    }),
  };
  return client;
}

const base = {
  id: "a1",
  workspace_id: "w1",
  status: "approved",
  approved_by: "u1",
  title: "Physio vs AT",
  slug: "physio-vs-at",
  content: { type: "doc", content: [] },
  meta_description: null,
};

describe("publishing a draft", () => {
  let publish: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    publish = vi.fn().mockResolvedValue({ externalId: "ext", url: "https://acme-physio.example/blog/physio-vs-at" });
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish });
  });

  it("drops the body <h1> that repeats the title", async () => {
    await publishArticleCore(fake({ ...base }) as never, "a1");
    const payload = publish.mock.calls[0][0] as PublishPayload;
    expect(payload.html).not.toContain("<h1>");
    expect(payload.html).toContain("<p>Hello world</p>");
  });

  it("writes a dateline into every article and keeps the first publish date", async () => {
    const client = fake({ ...base, published_at: "2026-09-01T09:00:00.000Z" });
    await publishArticleCore(client as never, "a1");
    const payload = publish.mock.calls[0][0] as PublishPayload;
    expect(payload.publishedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(payload.modifiedAt).toBeDefined();
    expect(payload.html).toMatch(/^<p class="article-dates"><em>Published September 1, 2026 · Updated [A-Z][a-z]+ \d{1,2}, \d{4}<\/em><\/p>/);
    expect(client.updates.find((u) => "published_at" in u)?.published_at).toBe("2026-09-01T09:00:00.000Z");
  });

  it("writes the dateline in the site's language, and none when the workspace could not be read", async () => {
    await publishArticleCore(fake({ ...base, published_at: "2026-09-01T09:00:00.000Z" }, { domain: "acme.example", language: "de" }) as never, "a1");
    expect((publish.mock.calls[0][0] as PublishPayload).html).toContain("Veröffentlicht am 1. September 2026");
    await publishArticleCore(fake({ ...base }, null) as never, "a1");
    expect((publish.mock.calls[1][0] as PublishPayload).html).not.toContain("article-dates");
  });

  it("does not keep a date from a push the CMS held as a draft: going live is the first publish", async () => {
    const client = fake({
      ...base,
      published_at: "2026-09-01T09:00:00.000Z",
      indexing_status: { indexnow: "held-in-cms", google: "held-in-cms" },
    });
    await publishArticleCore(client as never, "a1");
    const payload = publish.mock.calls[0][0] as PublishPayload;
    expect(payload.publishedAt).not.toBe("2026-09-01T09:00:00.000Z");
    expect(Date.now() - Date.parse(payload.publishedAt!)).toBeLessThan(60_000);
    // ...unless the article was found live on the site since: that date stands.
    await publishArticleCore(
      fake({ ...base, published_at: "2026-09-01T09:00:00.000Z", indexing_status: { indexnow: "held-in-cms" }, found_on_site_at: "2026-09-02T00:00:00.000Z" }) as never,
      "a1",
    );
    expect((publish.mock.calls[1][0] as PublishPayload).publishedAt).toBe("2026-09-01T09:00:00.000Z");
  });
});

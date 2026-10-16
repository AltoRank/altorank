import { describe, it, expect, vi, beforeEach } from "vitest";

// `deliverArticle` is the publish renderer after the gates, shared by Publish
// and by the Improvements push. A push of a reviewed rewrite used to send the
// CMS only a title and raw HTML: no dateline, no structured data, an empty
// Markdown body to a webhook. These run the real renderer on a push-shaped
// article (with a post id and a first-publish date). The caller may override
// the connection's publish mode: the push keeps an already-live post live.

vi.mock("@/lib/cms/adapter", () => ({ resolveCMSAdapter: vi.fn() }));
vi.mock("@/lib/seo/indexing", () => ({ submitForIndexing: vi.fn().mockResolvedValue({ indexnow: "submitted", google: "not-connected" }) }));
vi.mock("@/lib/seo/exchange", () => ({ settleExchangeForArticle: vi.fn() }));
const svc = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client }));

import { deliverArticle } from "../core";
import { resolveCMSAdapter } from "@/lib/cms/adapter";
import { htmlToTiptapJson } from "@/lib/ai/tiptap";
import type { PublishPayload } from "@/lib/cms/types";

function fake(integration: { type: string; publishMode?: string }) {
  const updates: Record<string, unknown>[] = [];
  const client = {
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
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { domain: "clinic.example", language: "en" }, error: null }) }) }) };
      }
      if (table === "workspace_output_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      }
      if (table === "workspace_integrations") {
        return {
          select: () => ({
            eq: async () => ({
              data: [
                {
                  id: "wi1",
                  publish_mode: integration.publishMode ?? "publish",
                  config: { type: integration.type, url: "https://hooks.example/in", siteUrl: "https://clinic.example" },
                  integration: { tag: "CMS", name: "My CMS" },
                },
              ],
            }),
          }),
        };
      }
      if (table === "publish_log") return { insert: async () => ({ error: null }) };
      return {};
    }),
  };
  svc.client = client;
  return client;
}

const pushed = {
  workspace_id: "w1",
  cms: "webhook",
  title: "Recovery guide",
  slug: "recovery-guide",
  content: htmlToTiptapJson("<h1>Recovery guide</h1><h2>Treatment</h2><p>New paragraph.</p>", {}),
  meta_description: "New meta",
  featured_image_url: null,
  external_id: "post-9",
  published_url: "https://clinic.example/blog/recovery-guide",
  keyword: "recovery",
  created_at: "2026-09-01T00:00:00.000Z",
  published_at: "2026-09-02T00:00:00.000Z",
};

describe("deliverArticle for an in-place update", () => {
  let update: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    update = vi.fn().mockResolvedValue({ externalId: "post-9", url: "https://clinic.example/blog/recovery-guide" });
    publish = vi.fn();
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ update, publish });
  });

  it("sends the dateline, the kept publish date, Markdown and the connection's mode", async () => {
    fake({ type: "webhook", publishMode: "draft" });
    await deliverArticle(svc.client as never, { ...pushed }, "a1", { inPlaceOnly: true });
    expect(publish).not.toHaveBeenCalled();
    const [id, payload] = update.mock.calls[0] as [string, PublishPayload];
    expect(id).toBe("post-9");
    expect(payload.publishMode).toBe("draft");
    expect(payload.publishedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(payload.modifiedAt).toEqual(expect.any(String));
    expect(payload.html).toMatch(/^<p class="article-dates">/);
    // The title goes as its own field: no second H1 in the body.
    expect(payload.html).not.toContain("<h1>");
    expect(payload.markdown).toContain("New paragraph.");
    expect(payload.structuredData?.length).toBeGreaterThan(0);
  });

  it("uses the caller's publish mode over the connection's, and logs that mode", async () => {
    const c = fake({ type: "webhook", publishMode: "draft" });
    const r = await deliverArticle(svc.client as never, { ...pushed }, "a1", { inPlaceOnly: true, publishMode: "publish" });
    const [, payload] = update.mock.calls[0] as [string, PublishPayload];
    expect(payload.publishMode).toBe("publish");
    expect(r.publishMode).toBe("publish");
    // Not held as a draft: the article stays live and is not marked held-in-cms.
    expect(c.updates[0]).toMatchObject({ status: "live" });
    expect(c.updates.some((u) => JSON.stringify(u).includes("held-in-cms"))).toBe(false);
  });

  it("refuses a destination that cannot edit the post, rather than publishing a second copy", async () => {
    (resolveCMSAdapter as ReturnType<typeof vi.fn>).mockReturnValue({ publish });
    fake({ type: "notion" });
    await expect(deliverArticle(svc.client as never, { ...pushed, cms: "notion" }, "a1", { inPlaceOnly: true })).rejects.toThrow(
      /cannot yet edit an existing one/,
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

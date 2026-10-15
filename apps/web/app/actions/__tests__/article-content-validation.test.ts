/**
 * An editor save is checked on the server: the body's links, images, embeds
 * and inline SVG figures are held to the allowlist sanitiser before the row is
 * written, whatever the client sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

let db: FakeSupabase;

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => db, createServiceClient: () => db }));
vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: async () => ({ user: { id: "u-editor", email: "editor@acme.example" }, accountId: "acc-1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/billing/body-lock", () => ({ sessionBodyLockedForWorkspace: async () => false }));

import { updateArticle } from "../articles";

beforeEach(() => {
  db = fakeSupabase({
    articles: [{ id: "a1", workspace_id: "ws-1", status: "draft", approved_by: null, content: null, featured_image_url: null }],
  });
});

const stored = () => db.tables.articles.find((a) => a.id === "a1")!;

describe("updateArticle: server-side content validation", () => {
  it("stores the body with unsafe links, figures and heading levels cleaned", async () => {
    await updateArticle("a1", {
      content: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: "2 onmouseover=x" }, content: [{ type: "text", text: "H" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
              { type: "text", text: "good", marks: [{ type: "link", attrs: { href: "https://ok.example" } }] },
            ],
          },
          { type: "svgFigure", attrs: { svg: "<svg></svg><img/src=x/onerror=alert(1)><svg></svg>" } },
          { type: "svgFigure", attrs: { svg: '<svg/onload=alert(1)><rect width="1"/></svg>' } },
        ],
      },
    });
    expect(stored().content).toEqual({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bad" },
            { type: "text", text: "good", marks: [{ type: "link", attrs: { href: "https://ok.example" } }] },
          ],
        },
        { type: "svgFigure", attrs: { svg: '<svg><rect width="1"></rect></svg>' } },
      ],
    });
  });

  it("refuses a body that is not a document, and writes nothing", async () => {
    await expect(updateArticle("a1", { content: "<p>x</p>" })).rejects.toThrow("must be a document");
    expect(stored().content).toBeNull();
  });

  it("refuses a featured image that is not an http(s) or relative address", async () => {
    await expect(updateArticle("a1", { featured_image_url: "javascript:alert(1)" })).rejects.toThrow("featured image");
    await updateArticle("a1", { featured_image_url: "https://cdn.example/x.webp" });
    expect(stored().featured_image_url).toBe("https://cdn.example/x.webp");
  });
});

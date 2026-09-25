/**
 * The editor's actions before the trial.
 *
 * Every one of them is the editor's, and the editor is what the trial opens.
 * The Markdown export is the one that hands text back from the row - the
 * stored meta description, which the model wrote from the body - so it is the
 * one asserted on: refused for an account before its trial, served for a
 * paying one. The gate is stubbed to each answer; it is tested in lib/billing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial";

const META = "Bu açıklama deneme süresi başlamadan gösterilmemeli.";
const ARTICLE = "33333333-3333-4333-8333-333333333333";
let locked = true;

function client() {
  const one = (data: unknown) => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data, error: null }) };
    return q;
  };
  return {
    from: (table: string) =>
      one(
        table === "articles"
          ? { id: ARTICLE, workspace_id: "ws1", title: "Rehber", keyword: "ajans", slug: "rehber", meta_description: META, featured_image_url: null, published_at: null }
          : { id: "ws1", domain: "acme-agency.example", brand_style: null },
      ),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client(), createServiceClient: () => client() }));
vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => ({ user: { id: "u1", email: "owner@acme-agency.example" }, accountId: "acc1", role: "owner" }) }));
vi.mock("@/lib/billing/body-lock", () => ({ sessionBodyLockedForWorkspace: async () => locked }));

beforeEach(() => {
  locked = true;
});

describe("renderMarkdownAction", () => {
  it("refuses an account before its trial, and hands back none of the row's text", async () => {
    const { renderMarkdownAction } = await import("../editor-ai");
    const res = await renderMarkdownAction({ articleId: ARTICLE, html: "<p>x</p>" });
    expect(res).toEqual({ ok: false, error: BODY_LOCKED_MESSAGE });
    expect(JSON.stringify(res)).not.toContain(META);
  });

  it("renders for a paying account, meta description included", async () => {
    locked = false;
    const { renderMarkdownAction } = await import("../editor-ai");
    const res = await renderMarkdownAction({ articleId: ARTICLE, html: "<p>x</p>" });
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res)).toContain(META);
  });
});

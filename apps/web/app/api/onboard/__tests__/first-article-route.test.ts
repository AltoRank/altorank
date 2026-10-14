import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /api/onboard/first-article: who is asking, and a refusal that says
// nothing about why. The checks themselves are lib/onboarding/first-article-body.ts
// (and its db test, which runs them against signed-in clients).

const { user, read } = vi.hoisted(() => ({
  user: { value: null as null | { id: string } },
  read: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user.value } }) } }),
}));
vi.mock("@/lib/onboarding/first-article-body", () => ({ readFirstArticleBody: (...a: unknown[]) => read(...a) }));

import { GET } from "../first-article/route";
import { NextRequest } from "next/server";

const get = (qs: string) => GET(new NextRequest(`https://app.example/api/onboard/first-article${qs}`));

beforeEach(() => {
  user.value = { id: "u1" };
  read.mockReset();
});

describe("GET /api/onboard/first-article", () => {
  it("refuses a caller who is not signed in, and reads nothing", async () => {
    user.value = null;
    expect((await get("?workspaceId=ws1")).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers every refusal the same way, uncached", async () => {
    for (const reason of ["off", "not-found", "not-owner", "no-first-article"]) {
      read.mockResolvedValueOnce({ ok: false, reason });
      const res = await get("?workspaceId=ws1");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("hands over the text the reader allowed, for the signed-in person", async () => {
    read.mockResolvedValue({ ok: true, articleId: "a1", html: "<p>x</p>", done: false });
    const res = await get("?workspaceId=ws1");
    expect(await res.json()).toEqual({ articleId: "a1", html: "<p>x</p>", done: false });
    expect(read).toHaveBeenCalledWith(expect.anything(), "u1", "ws1");
  });
});

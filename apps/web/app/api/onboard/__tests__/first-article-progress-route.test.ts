import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /api/onboard/first-article/progress: the gate's outline ticks while the
// body is written. Who is asking, a refusal that says nothing about why, and
// an answer built from counts alone - whatever else the read carries. The
// checks themselves are lib/onboarding/first-article-body.ts (and its db
// test, against signed-in clients).

const { user, read } = vi.hoisted(() => ({
  user: { value: null as null | { id: string } },
  read: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: user.value } }) } }),
}));
vi.mock("@/lib/onboarding/first-article-body", () => ({ readFirstArticleProgress: (...a: unknown[]) => read(...a) }));

import { GET } from "../first-article/progress/route";
import { NextRequest } from "next/server";

const get = (qs: string) => GET(new NextRequest(`https://app.example/api/onboard/first-article/progress${qs}`));

beforeEach(() => {
  user.value = { id: "u1" };
  read.mockReset();
});

describe("GET /api/onboard/first-article/progress", () => {
  it("refuses a caller who is not signed in, and reads nothing", async () => {
    user.value = null;
    expect((await get("?workspaceId=ws1")).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers every refusal the same way, uncached", async () => {
    for (const reason of ["not-found", "not-owner", "no-first-article"]) {
      read.mockResolvedValueOnce({ ok: false, reason });
      const res = await get("?workspaceId=ws1");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("hands over counts only, even when the read carries more", async () => {
    read.mockResolvedValue({
      ok: true, articleId: "a1", done: false, stage: "writing", stageMs: 900, sectionsDone: [0, 1], sections: 6, words: 412,
      // Nothing like this is read today; if it ever were, it would not leave.
      html: "<p>secret</p>", body_stream: "secret", title: "secret",
    });
    const res = await get("?workspaceId=ws1");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["articleId", "done", "sections", "sectionsDone", "stage", "stageMs", "words"]);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(read).toHaveBeenCalledWith(expect.anything(), "u1", "ws1");
  });
});

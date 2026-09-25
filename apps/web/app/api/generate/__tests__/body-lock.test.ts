/**
 * POST /api/generate streams the article as it is written, so for an account
 * that has not started its trial it is a way to read a body as much as a way
 * to write one. It refuses before generating anything; a paying account's
 * stream is unchanged. The gate itself is tested in lib/billing; here it is
 * stubbed to each answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BODY_LOCKED_MESSAGE } from "@/lib/billing/trial";

const SECRET = "Bu cümle deneme süresi başlamadan hiçbir yerde görünmemeli.";

let gate: "open" | "gated" | "bypassed";
const generateArticle = vi.fn();

function client() {
  const one = (data: unknown) => {
    const q = { select: () => q, eq: () => q, single: async () => ({ data, error: null }) };
    return q;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "owner@acme-agency.example" } }, error: null }) },
    from: (table: string) => one(table === "workspaces" ? { id: "ws1", account_id: "acc1" } : { id: "m1" }),
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
vi.mock("@/lib/billing/body-lock", () => ({ sessionTrialGate: async () => gate }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generateArticle(...a) }));

const post = () =>
  new NextRequest("http://localhost:3141/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws1", keyword: "ajans rehberi" }),
  });

beforeEach(() => {
  gate = "gated";
  generateArticle.mockReset();
  generateArticle.mockImplementation(async (opts: { onChunk?: (html: string) => void }) => {
    opts.onChunk?.(`<p>${SECRET}</p>`);
    return {
      articleId: "a1",
      jobId: "j1",
      title: "Rehber",
      wordCount: 9,
      tokensUsed: 10,
      factCheck: { verdict: "clean", summary: "", counts: { total: 0 } },
    };
  });
});

describe("POST /api/generate and the trial gate", () => {
  it("refuses an account before its trial, before any generation starts", async () => {
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: BODY_LOCKED_MESSAGE, reason: "trial_required" });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("streams as before for a paying account", async () => {
    gate = "open";
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SECRET);
  });

  it("streams for a bypassed test address, which reaches the dashboard", async () => {
    gate = "bypassed";
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(200);
  });
});

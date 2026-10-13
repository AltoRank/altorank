/**
 * POST /api/generate streams the article as it is written, so for an account
 * that has not started its trial it is a way to read a body as much as a way
 * to write one. It refuses before generating anything; a paying account's
 * stream is unchanged. The gate itself is tested in lib/billing; here it is
 * stubbed to each answer.
 *
 * The refusal is worded by what was asked (lib/billing/trial-refusal.ts): a
 * new keyword is another draft and gets the hold's sentence, the one the
 * agent API gives for the same request; writing into an open draft is its
 * text and gets the body lock's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BODY_LOCKED_MESSAGE, TRIAL_HOLD_MESSAGE } from "@/lib/billing/trial-refusal";
import { trialHoldReason } from "@/lib/billing/trial-hold";

const SECRET = "Bu cümle deneme süresi başlamadan hiçbir yerde görünmemeli.";

let gate: "open" | "gated" | "bypassed";
// Drafts the account already has. The gate is stubbed, so this only moves the
// hold: 1 is the onboarding's first article, 0 is "not written yet".
let used: number;
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
vi.mock("@/lib/queries/quota", () => ({
  getRequestQuota: async () => ({ reason: "no-plan", trialEligible: true, used }),
}));
vi.mock("@/lib/stripe", async (importOriginal) => ({ ...(await importOriginal<object>()), billingEnabled: true }));
vi.mock("@/lib/content/generate", () => ({ generateArticle: (...a: unknown[]) => generateArticle(...a) }));

const post = (extra: { articleId?: string } = {}) =>
  new NextRequest("http://localhost:3141/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "ws1", keyword: "ajans rehberi", ...extra }),
  });

beforeEach(() => {
  gate = "gated";
  used = 1;
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
  it("refuses a new draft before the trial in the hold's words, before any generation starts", async () => {
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: TRIAL_HOLD_MESSAGE, reason: "trial_required" });
    // The same sentence the agent API, Write now and the crons give.
    expect(body.error).toBe(trialHoldReason({ reason: "no-plan", trialEligible: true, used: 1 }));
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("refuses writing into an open draft in the body lock's words", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ articleId: "a1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: BODY_LOCKED_MESSAGE, reason: "trial_required" });
    expect(generateArticle).not.toHaveBeenCalled();
  });

  it("refuses a new keyword the hold would allow for the text the stream would show", async () => {
    // No first article yet, so "your first article is written" would be false;
    // what this door would hand over is text.
    used = 0;
    const { POST } = await import("../route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: BODY_LOCKED_MESSAGE, reason: "trial_required" });
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

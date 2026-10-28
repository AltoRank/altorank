import { beforeEach, describe, expect, it, vi } from "vitest";

// The setup screen's soft exits (UX audit 2026-10-12, #3): only the owner,
// only before the trial, only to the address they are signed in with, and
// never past an unsubscribe.

const m = vi.hoisted(() => ({
  auth: { user: { id: "u1", email: "Owner@Acme-Shop.example" }, accountId: "acc1", role: "owner" },
  gate: "gated" as "gated" | "open" | "bypassed",
  unsubscribed: [] as string[],
  article: { id: "a1", title: "Acme kits", state: "written" } as { id: string; title: string; state: "outlined" | "written" } | null,
  send: vi.fn(),
}));

vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: async () => m.auth }));
vi.mock("@/lib/queries/quota", () => ({ getRequestQuota: async () => ({ reason: "no-plan", trialEligible: true }) }));
vi.mock("@/lib/billing/trial", () => ({ trialGateState: () => m.gate }));
vi.mock("@/lib/dev/simulation", () => ({ getSimulation: async () => null }));
vi.mock("@/lib/email/preferences", () => ({ readUnsubscribed: async () => m.unsubscribed }));
vi.mock("@/lib/onboarding/first-article", () => ({ loadFirstArticle: async () => ({ article: m.article, writing: false }) }));
vi.mock("@/lib/email/first-look-exits", () => ({ sendFirstArticleLink: m.send }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({}),
  createClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { domain: "acme-shop.example" } }) }) }) }) }),
}));

import { emailFirstArticle, emailWhenReady } from "../first-look-exits";

beforeEach(() => {
  m.auth = { user: { id: "u1", email: "Owner@Acme-Shop.example" }, accountId: "acc1", role: "owner" };
  m.gate = "gated";
  m.unsubscribed = [];
  m.article = { id: "a1", title: "Acme kits", state: "written" };
  m.send.mockReset();
  m.send.mockResolvedValue({ sent: 1, skipped: 0, failed: 0 });
});

describe("Email me this article", () => {
  it("sends to the owner's own signed-in address, about this site's first article", async () => {
    expect(await emailFirstArticle("ws1")).toEqual({ ok: true, email: "owner@acme-shop.example" });
    expect(m.send).toHaveBeenCalledWith(expect.anything(), "owner@acme-shop.example", expect.objectContaining({ articleId: "a1", workspaceId: "ws1", accountId: "acc1" }));
  });

  it("is refused to a member who is not the owner, and once the trial has started", async () => {
    m.auth = { ...m.auth, role: "member" };
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false });
    m.auth = { ...m.auth, role: "owner" };
    m.gate = "open";
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("respects an unsubscribe from draft emails, and says so", async () => {
    m.unsubscribed = ["drafts"];
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false, message: expect.stringContaining("turned off") });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("says when it was already sent, and when the daily cap is reached", async () => {
    m.send.mockResolvedValue({ sent: 0, skipped: 1, failed: 0 });
    expect(await emailFirstArticle("ws1")).toEqual({ ok: true, email: "owner@acme-shop.example", already: true });
    m.send.mockResolvedValue({ sent: 0, skipped: 1, failed: 0, capped: true });
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false, message: expect.stringContaining("tomorrow") });
  });

  it("sends nothing for an article still being written: the one send is kept for the text", async () => {
    m.article = { id: "a1", title: "Acme kits", state: "outlined" };
    expect(await emailFirstArticle("ws1")).toEqual({ ok: false, message: "It is still being written. Ask again once it is.", retry: true });
    expect(m.send).not.toHaveBeenCalled();
  });

  it("says a failed send can be asked again, and a capped one cannot", async () => {
    m.send.mockResolvedValue({ sent: 0, skipped: 0, failed: 1 });
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false, retry: true });
    m.send.mockResolvedValue({ sent: 0, skipped: 1, failed: 0, capped: true });
    expect(await emailFirstArticle("ws1")).not.toHaveProperty("retry");
  });

  it("has nothing to send without an article", async () => {
    m.article = null;
    expect(await emailFirstArticle("ws1")).toMatchObject({ ok: false });
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("Email me when it's ready", () => {
  it("promises the written-article email only to an owner who gets draft emails", async () => {
    expect(await emailWhenReady("ws1")).toEqual({ ok: true, email: "owner@acme-shop.example" });
    m.unsubscribed = ["all"];
    expect(await emailWhenReady("ws1")).toMatchObject({ ok: false });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/onboard/step: signed in, a member of the workspace's account, a
// step it knows. The write itself is lib/onboarding/step-events.ts.

const { user, workspace, member, record, scoped, run, article } = vi.hoisted(() => ({
  article: { value: null as null | { id: string; workspace_id: string } },
  user: { value: null as null | { id: string; created_at: string } },
  workspace: { value: null as null | { id: string; account_id: string } },
  member: { value: null as null | { id: string } },
  record: vi.fn(async () => true),
  scoped: { value: null as string | null },
  run: { value: null as null | { status: string } },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: user.value } }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => ({ data: table === "workspaces" ? workspace.value : table === "onboarding_runs" ? run.value : table === "articles" ? article.value : member.value, error: null });
      return q;
    },
  }),
  createServiceClient: () => ({ service: true }),
}));
vi.mock("@/lib/workspace-scope", () => ({ getScopedWorkspaceId: async () => scoped.value }));
const owned = vi.hoisted(() => vi.fn(async (_db: unknown, _account: string, raw: unknown) => (raw === "cs_test_ours000000000000" ? raw : undefined)));
vi.mock("@/lib/onboarding/step-events", () => ({
  recordOnboardingStep: (...a: unknown[]) => record(...(a as [])),
  ownedCheckoutSession: (...a: [unknown, string, unknown]) => owned(...a),
}));
const impersonation = vi.hoisted(() => ({ value: null as null | { targetEmail: string } }));
vi.mock("@/lib/auth/impersonation", () => ({ getImpersonation: async () => impersonation.value }));

import { POST } from "../step/route";

const A = "11111111-2222-4333-8444-555555555555";

const post = (body: unknown) =>
  POST(new Request("https://app.example/api/onboard/step", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never);

beforeEach(() => {
  user.value = { id: "u1", created_at: new Date(Date.now() - 120_000).toISOString() };
  workspace.value = { id: "ws1", account_id: "acc1" };
  member.value = { id: "m1" };
  scoped.value = "ws1";
  run.value = { status: "done" };
  impersonation.value = null;
  article.value = null;
  record.mockClear();
  owned.mockClear();
});

describe("POST /api/onboard/step", () => {
  it("refuses a caller who is not signed in", async () => {
    user.value = null;
    expect((await post({ step: "wizard_opened" })).status).toBe(401);
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a step it does not know", async () => {
    expect((await post({ step: "anything" })).status).toBe(400);
  });

  it("refuses a workspace the caller cannot see, or whose account they are not in", async () => {
    workspace.value = null;
    expect((await post({ step: "wizard_opened", workspaceId: "ws-other" })).status).toBe(404);
    workspace.value = { id: "ws2", account_id: "acc2" };
    member.value = null;
    expect((await post({ step: "wizard_opened", workspaceId: "ws2" })).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("records the step for the scoped workspace, with the gate's seconds since signup worked out on the server", async () => {
    expect((await post({ step: "gate_shown", ms: 5 })).status).toBe(204);
    expect(record).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ workspaceId: "ws1", accountId: "acc1", userId: "u1", step: "gate_shown" }));
    const input = (record.mock.calls[0] as unknown as [unknown, { secondsSinceSignup: number }])[1];
    expect(input.secondsSinceSignup).toBeGreaterThanOrEqual(119);
    expect(input.secondsSinceSignup).toBeLessThan(200);
  });

  it("never takes the server's own step from the browser, nor the gate before a run has reached it", async () => {
    expect((await post({ step: "run_started" })).status).toBe(400);
    run.value = { status: "running" };
    expect((await post({ step: "gate_shown" })).status).toBe(204);
    run.value = null;
    expect((await post({ step: "gate_shown" })).status).toBe(204);
    expect(record).not.toHaveBeenCalled();
    // Other steps are not held to the run.
    await post({ step: "wizard_opened" });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("carries a timed step's milliseconds and nothing the browser makes up", async () => {
    await post({ step: "site_read_finished", ms: 4200, workspaceId: "ws1", email: "someone@acme.example" });
    const input = (record.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(input).toMatchObject({ step: "site_read_finished", ms: 4200, secondsSinceSignup: null });
    expect(JSON.stringify(input)).not.toContain("someone@");
  });

  it("writes nothing while an operator is viewing as the account: the step is the customer's to reach", async () => {
    impersonation.value = { targetEmail: "owner@acme-agency.example" };
    expect((await post({ step: "site_read_finished" })).status).toBe(204);
    expect(record).not.toHaveBeenCalled();
  });

  it("never takes the trial or an approval from the browser: Stripe and the server say those", async () => {
    expect((await post({ step: "trial_started" })).status).toBe(400);
    expect((await post({ step: "article_approved", articleId: A })).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps a step's words on its list and drops the rest", async () => {
    await post({ step: "setup_ending_shown", workspaceId: "ws1", props: { ending: "nothing-planned", note: "someone@acme.example" } });
    await post({ step: "offer_seen", props: { viewport: "1280x720" } });
    const [ending, offer] = record.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1]);
    expect(ending).toMatchObject({ step: "setup_ending_shown", workspaceId: "ws1", props: { ending: "nothing-planned" } });
    expect(offer).toMatchObject({ step: "offer_seen", props: {} });
    expect(JSON.stringify(record.mock.calls)).not.toContain("someone@");
  });

  it("finds an article step's site from the article, through the person's own client", async () => {
    article.value = { id: A, workspace_id: "ws1" };
    scoped.value = "ws-other";
    expect((await post({ step: "article_copied", articleId: A, workspaceId: "ws-forged", props: { format: "markdown", surface: "publish_panel" } })).status).toBe(204);
    expect(record).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ workspaceId: "ws1", accountId: "acc1", step: "article_copied", articleId: A, props: { format: "markdown", surface: "publish_panel" } }),
    );
  });

  it("takes Next up's click as an article step: the site is the draft's", async () => {
    article.value = { id: A, workspace_id: "ws1" };
    expect((await post({ step: "next_up_clicked", articleId: A, props: { target: "draft" } })).status).toBe(204);
    expect(record).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ workspaceId: "ws1", step: "next_up_clicked", articleId: A, props: { target: "draft" } }));
    expect((await post({ step: "next_up_clicked", props: { target: "draft" } })).status).toBe(400);
  });

  it("refuses an article step without an article id, or with one the person cannot see", async () => {
    expect((await post({ step: "article_opened", props: { from: "setup" } })).status).toBe(400);
    expect((await post({ step: "article_opened", articleId: "../etc", props: { from: "setup" } })).status).toBe(400);
    article.value = null;
    expect((await post({ step: "article_opened", articleId: A, props: { from: "setup" } })).status).toBe(404);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps a checkout step's Stripe session only when it is the account's own", async () => {
    await post({ step: "checkout_closed", checkoutId: "cs_test_ours000000000000", props: { how: "escape", surface: "price_box", viewport: "mobile" } });
    await post({ step: "checkout_failed", checkoutId: "cs_test_someone_elses0000", props: { stage: "mount", surface: "sticky_bar" } });
    expect(owned).toHaveBeenCalledWith({ service: true }, "acc1", "cs_test_ours000000000000");
    const [closed, failed] = record.mock.calls.map((c) => (c as unknown as [unknown, Record<string, unknown>])[1]);
    expect(closed).toMatchObject({ step: "checkout_closed", checkoutId: "cs_test_ours000000000000", props: { how: "escape", surface: "price_box", viewport: "mobile" } });
    expect(failed).toMatchObject({ step: "checkout_failed", checkoutId: null, props: { stage: "mount", surface: "sticky_bar" } });
  });

  it("never reads a session for a step that is not about a checkout", async () => {
    await post({ step: "trial_clicked", checkoutId: "cs_test_ours000000000000", props: { surface: "articles", plan: "starter", interval: "month" } });
    expect(owned).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ step: "trial_clicked", checkoutId: null, props: { surface: "articles", plan: "starter", interval: "month" } }));
  });
});

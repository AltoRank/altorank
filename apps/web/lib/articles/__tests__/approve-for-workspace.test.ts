/**
 * The session-free approval the Shopify app uses. RLS is not there to help,
 * so the scoping to the caller's own site is the permission check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  needsPlanToShip: vi.fn(),
  accountTrialGate: vi.fn(),
  readArticlesWhole: vi.fn(),
  announceDraftApproved: vi.fn(),
  serviceUpdate: vi.fn(),
  factCheckArticle: vi.fn(),
  approvalBlocker: vi.fn(),
  recordArticlesApproved: vi.fn(),
}));

vi.mock("@/lib/billing/quota", () => ({ needsPlanToShip: m.needsPlanToShip, CHOOSE_PLAN_MESSAGE: "Choose a plan" }));
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: m.accountTrialGate }));
vi.mock("@/lib/billing/trial-refusal", () => ({ BODY_LOCKED_MESSAGE: "Body locked" }));
vi.mock("@/lib/articles/body-read", () => ({ readArticlesWhole: m.readArticlesWhole }));
vi.mock("@/lib/email/approval-events", () => ({ announceDraftApproved: m.announceDraftApproved }));
vi.mock("@/lib/i18n/workspace-language", () => ({ readWorkspaceLanguage: async () => "en" }));
vi.mock("@/lib/ai/fact-check", () => ({ factCheckArticle: m.factCheckArticle, approvalBlocker: m.approvalBlocker }));
vi.mock("@/lib/cms/html", () => ({ tiptapToHtml: () => "<p>x</p>" }));
vi.mock("@/lib/onboarding/step-events", () => ({ recordArticlesApproved: m.recordArticlesApproved }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      // writeApproval reads which site each article is on, then that site's
      // schedule: none here, so the approval stays `approved`.
      select: () => ({
        in: (_c: string, ids: string[]) => ({
          eq: async () => ({ data: table === "articles" ? ids.map((id) => ({ id, workspace_id: "ws-1" })) : [], error: null }),
        }),
      }),
      update: (values: Record<string, unknown>) => ({
        in: (_c: string, ids: string[]) => ({
          eq: () => ({ select: async () => m.serviceUpdate(values, ids) }),
        }),
      }),
    }),
  }),
}));

import { approveForWorkspace } from "../approve";

/** Articles the fake db knows: only a1 is on ws-1 and in review. */
const ROWS = [
  { id: "a1", workspace_id: "ws-1", status: "review" },
  { id: "a2", workspace_id: "ws-OTHER", status: "review" },
];
function db() {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    eq: (col: string, val: unknown) => ((filters[col] = val), chain),
    maybeSingle: async () => ({
      data: ROWS.find((r) => Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null,
    }),
  };
  return { from: () => chain } as never;
}

const who = { accountId: "acc-1", workspaceId: "ws-1", userId: "owner-1", actor: { email: "o@fern.com", user_metadata: {} } };

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.needsPlanToShip.mockResolvedValue(false);
  m.accountTrialGate.mockResolvedValue("open");
  m.readArticlesWhole.mockResolvedValue([{ id: "a1", content: { type: "doc" }, research: null, workspace_id: "ws-1" }]);
  m.factCheckArticle.mockReturnValue({ verdict: "clean" });
  m.approvalBlocker.mockReturnValue(null);
  m.serviceUpdate.mockImplementation(async (_v, ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null }));
});

describe("approveForWorkspace", () => {
  it("approves an article in review on the caller's own site, under the given user", async () => {
    await approveForWorkspace(db(), who, "a1");
    expect(m.serviceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", approved_by: "owner-1", approval_kind: "human" }),
      ["a1"],
    );
    expect(m.announceDraftApproved).toHaveBeenCalledWith("a1", who.actor);
    // The funnel's approval (onboarding.step): what moved, on its site, by whom.
    expect(m.recordArticlesApproved).toHaveBeenCalledWith(expect.anything(), [{ id: "a1", workspaceId: "ws-1", status: "approved" }], "owner-1");
  });

  it("refuses an article on another site, before reading any body", async () => {
    await expect(approveForWorkspace(db(), who, "a2")).rejects.toThrow(/must be in review/);
    expect(m.readArticlesWhole).not.toHaveBeenCalled();
    expect(m.serviceUpdate).not.toHaveBeenCalled();
  });

  it("asks for a plan first", async () => {
    m.needsPlanToShip.mockResolvedValue(true);
    await expect(approveForWorkspace(db(), who, "a1")).rejects.toThrow("Choose a plan");
    expect(m.needsPlanToShip).toHaveBeenCalledWith(expect.anything(), "acc-1", null);
  });

  it("refuses while the account's draft bodies are locked", async () => {
    m.accountTrialGate.mockResolvedValue("gated");
    await expect(approveForWorkspace(db(), who, "a1")).rejects.toThrow("Body locked");
  });

  it("refuses an unsourced figure, like the dashboard does", async () => {
    m.approvalBlocker.mockReturnValue("Two figures have no source.");
    await expect(approveForWorkspace(db(), who, "a1")).rejects.toThrow("Two figures have no source.");
    expect(m.serviceUpdate).not.toHaveBeenCalled();
    expect(m.recordArticlesApproved).not.toHaveBeenCalled();
  });

  it("records nothing approved when the row moved under it", async () => {
    m.serviceUpdate.mockResolvedValue({ data: [], error: null });
    await expect(approveForWorkspace(db(), who, "a1")).rejects.toThrow(/must be in review/);
    expect(m.recordArticlesApproved).toHaveBeenCalledWith(expect.anything(), [], "owner-1");
  });
});

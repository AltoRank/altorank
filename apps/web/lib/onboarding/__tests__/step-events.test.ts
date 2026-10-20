import { describe, expect, it } from "vitest";
import { ownedCheckoutSession, recordOnboardingStep, stepContext, stepEventId } from "../step-events";
import { ONBOARDING_STEPS, isClientStep, isOnboardingStep } from "../step-names";

describe("onboarding.step events", () => {
  it("carry the step, the ids and bounded numbers, nothing else", () => {
    expect(stepContext({ workspaceId: "w", accountId: "a", userId: "u", step: "site_read_finished", ms: 1234.6 })).toEqual({ step: "site_read_finished", userId: "u", ms: 1235 });
    expect(stepContext({ workspaceId: "w", accountId: null, userId: null, step: "gate_shown", secondsSinceSignup: -3, ms: Number.NaN })).toEqual({ step: "gate_shown" });
    expect(stepContext({ workspaceId: "w", accountId: null, userId: null, step: "site_read_finished", ms: 9e12 }).ms).toBe(3_600_000);
  });

  it("have one id per step per workspace, shaped as a uuid", () => {
    const id = stepEventId("ws-1", "gate_shown");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stepEventId("ws-1", "gate_shown")).toBe(id);
    expect(stepEventId("ws-2", "gate_shown")).not.toBe(id);
    expect(stepEventId("ws-1", "trial_clicked")).not.toBe(id);
  });

  it("name every step the screens report", () => {
    expect(ONBOARDING_STEPS).toContain("checkout_returned");
    expect(isOnboardingStep("plan_clicked")).toBe(true);
    expect(isOnboardingStep("drop table")).toBe(false);
  });

  it("keep site_added to the server: the browser cannot claim a site was made", () => {
    expect(isOnboardingStep("site_added")).toBe(true);
    expect(isClientStep("site_added")).toBe(false);
  });
});

describe("onboarding.step events after the run", () => {
  const A = "11111111-2222-4333-8444-555555555555";

  it("carry the article or run they were about and the step's own words, nothing else", () => {
    expect(
      stepContext({
        workspaceId: "w",
        accountId: "a",
        userId: null,
        step: "article_copied",
        articleId: A,
        props: { format: "html", surface: "export_menu", ...({ email: "someone@acme.example" } as object) },
      }),
    ).toEqual({ step: "article_copied", articleId: A, format: "html", surface: "export_menu" });
    // A run id that is not an id is left out, not written as text.
    expect(stepContext({ workspaceId: "w", accountId: null, userId: null, step: "run_started", runId: "not an id", props: { trigger: "first" } })).toEqual({ step: "run_started", trigger: "first" });
  });

  it("keep the id every step had before, and give a keyed step one id per key", () => {
    expect(stepEventId("ws-1", "gate_shown", "")).toBe(stepEventId("ws-1", "gate_shown"));
    const writing = stepEventId("ws-1", "setup_ending_shown", "writing");
    expect(writing).not.toBe(stepEventId("ws-1", "setup_ending_shown", "article"));
    expect(writing).not.toBe(stepEventId("ws-1", "setup_ending_shown"));
    expect(writing).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("are never accepted from the browser when only the server can know them", () => {
    for (const step of ["run_started", "trial_started", "article_approved"]) expect(isClientStep(step)).toBe(false);
    for (const step of ["setup_ending_shown", "offer_seen", "article_opened", "article_copied"]) expect(isClientStep(step)).toBe(true);
  });
});

describe("onboarding.step events about a checkout", () => {
  const S = "cs_test_a1B2c3D4e5F6g7H8i9J0";
  const db = (row: unknown, error: unknown = null) =>
    ({
      from: (table: string) => {
        expect(table).toBe("billing_checkout_attempts");
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.maybeSingle = async () => ({ data: row, error });
        return q;
      },
    }) as never;

  it("carry the session and the step's words, nothing else", () => {
    expect(stepContext({ workspaceId: "w", accountId: "a", userId: null, step: "checkout_closed", checkoutSession: S, props: { how: "escape", surface: "price_box", viewport: "mobile" } })).toEqual({
      step: "checkout_closed",
      checkoutSession: S,
      how: "escape",
      surface: "price_box",
      viewport: "mobile",
    });
    expect(stepContext({ workspaceId: "w", accountId: "a", userId: null, step: "checkout_failed", checkoutSession: "not a session", props: { stage: "create" } })).toEqual({ step: "checkout_failed", stage: "create" });
  });

  it("are new events, never accepted only from the server", () => {
    for (const step of ["checkout_closed", "checkout_failed"]) {
      expect(isOnboardingStep(step)).toBe(true);
      expect(isClientStep(step)).toBe(true);
    }
  });

  it("keep a session only when it is the one the account has open", async () => {
    expect(await ownedCheckoutSession(db({ stripe_session_id: S }), "acc1", S)).toBe(S);
    expect(await ownedCheckoutSession(db({ stripe_session_id: "cs_test_another000000000" }), "acc1", S)).toBeUndefined();
    expect(await ownedCheckoutSession(db(null), "acc1", S)).toBeUndefined();
    expect(await ownedCheckoutSession(db({ stripe_session_id: S }, { message: "down" }), "acc1", S)).toBeUndefined();
    // Not a session id: nothing is read at all.
    expect(await ownedCheckoutSession({ from: () => { throw new Error("read"); } } as never, "acc1", "x")).toBeUndefined();
  });
});

describe("onboarding.step trial clicks on one site", () => {
  const W = "11111111-2222-4333-8444-555555555555";
  // system_events as the upsert sees it: a row per id, a second write of an
  // id is ignored (ignoreDuplicates).
  const table = () => {
    const ids = new Set<string>();
    const db = {
      from: () => ({
        upsert: (row: { id: string }) => ({
          select: async () => {
            if (ids.has(row.id)) return { data: [], error: null };
            ids.add(row.id);
            return { data: [{ id: row.id }], error: null };
          },
        }),
      }),
    } as never;
    return { db, ids };
  };
  const click = (checkout: "hosted" | "embedded") => ({ workspaceId: W, accountId: null, userId: null, step: "trial_clicked" as const, props: { surface: "price_box" as const, plan: "starter" as const, interval: "month" as const, checkout } });

  it("keep an embedded click and then a hosted click as two rows, and a repeat of either as none", async () => {
    const { db, ids } = table();
    expect(await recordOnboardingStep(db, click("embedded"))).toBe(true);
    expect(await recordOnboardingStep(db, click("hosted"))).toBe(true);
    expect(await recordOnboardingStep(db, click("hosted"))).toBe(false);
    expect(await recordOnboardingStep(db, click("embedded"))).toBe(false);
    expect(ids.size).toBe(2);
  });

  it("write which checkout it was into the event", () => {
    expect(stepContext(click("hosted"))).toEqual({ step: "trial_clicked", surface: "price_box", plan: "starter", interval: "month", checkout: "hosted" });
  });
});

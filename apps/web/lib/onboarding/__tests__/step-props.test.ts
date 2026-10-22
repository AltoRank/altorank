import { describe, expect, it } from "vitest";
import { SETUP_ENDINGS, checkoutSessionOrUndefined, openedFrom, stepKey, stepProps, uuidOrUndefined, viewportOf } from "../step-props";

// What an onboarding.step event may carry beyond its name: a word from a
// closed list, per step. These are the guarantee that no event payload holds
// anything a person typed.

describe("stepProps", () => {
  it("keeps a step's own props with a value on its list", () => {
    expect(stepProps("setup_ending_shown", { ending: "nothing-planned" })).toEqual({ ending: "nothing-planned" });
    expect(stepProps("offer_seen", { viewport: "mobile" })).toEqual({ viewport: "mobile" });
    expect(stepProps("article_opened", { from: "setup", viewport: "desktop" })).toEqual({ from: "setup", viewport: "desktop" });
    expect(stepProps("article_copied", { format: "markdown", surface: "export_menu" })).toEqual({ format: "markdown", surface: "export_menu" });
    expect(stepProps("article_approved", { status: "scheduled" })).toEqual({ status: "scheduled" });
    expect(stepProps("run_started", { trigger: "provider_retry" })).toEqual({ trigger: "provider_retry" });
    expect(stepProps("trial_started", { plan: "growth" })).toEqual({ plan: "growth" });
    expect(stepProps("next_up_clicked", { target: "draft" })).toEqual({ target: "draft" });
    expect(stepProps("next_up_clicked", { target: "/articles?status=review" })).toEqual({});
  });

  it("drops anything else: another step's prop, a value off the list, free text, a non-string", () => {
    expect(stepProps("setup_ending_shown", { ending: "someone@acme.example" })).toEqual({});
    expect(stepProps("article_opened", { from: "https://mail.example/inbox", viewport: 1280 })).toEqual({});
    expect(stepProps("article_copied", { format: "html", surface: "export_menu", email: "someone@acme.example", text: "<p>body</p>" })).toEqual({ format: "html", surface: "export_menu" });
    // A step with no props takes none, whatever is sent.
    expect(stepProps("wizard_opened", { ending: "article" })).toEqual({});
    expect(stepProps("offer_seen", null)).toEqual({});
    expect(stepProps("offer_seen", "mobile")).toEqual({});
  });

  it("names every ending setup can end on, each once", () => {
    // The type check in step-props.ts fails the build when SetupEnding grows
    // and this list does not; this is the list itself.
    expect(new Set(SETUP_ENDINGS).size).toBe(SETUP_ENDINGS.length);
    expect([...SETUP_ENDINGS].sort()).toEqual(["article", "first-failed", "no-article", "nothing-planned", "provider-down", "retry", "writing"]);
  });
});

describe("stepKey: what tells two events of one step apart", () => {
  const A = "11111111-2222-4333-8444-555555555555";
  it("is empty for the steps kept once per site, as before", () => {
    expect(stepKey("gate_shown", {})).toBe("");
    expect(stepKey("offer_seen", { props: { viewport: "mobile" } })).toBe("");
    expect(stepKey("trial_started", { props: { plan: "starter" } })).toBe("");
  });

  it("keeps an ending, an article, a copy button and a run apart", () => {
    expect(stepKey("setup_ending_shown", { props: { ending: "writing" } })).not.toBe(stepKey("setup_ending_shown", { props: { ending: "article" } }));
    expect(stepKey("article_opened", { articleId: A, props: { from: "setup", viewport: "mobile" } })).toBe(stepKey("article_opened", { articleId: A, props: { from: "setup", viewport: "desktop" } }));
    expect(stepKey("article_opened", { articleId: A, props: { from: "setup" } })).not.toBe(stepKey("article_opened", { articleId: A, props: { from: "articles" } }));
    expect(stepKey("article_copied", { articleId: A, props: { format: "html", surface: "publish_panel" } })).not.toBe(stepKey("article_copied", { articleId: A, props: { format: "html", surface: "export_menu" } }));
    expect(stepKey("article_approved", { articleId: A, props: { status: "approved" } })).toBe(stepKey("article_approved", { articleId: A, props: { status: "scheduled" } }));
    expect(stepKey("run_started", { runId: "r1" })).not.toBe(stepKey("run_started", { runId: "r2" }));
    expect(stepKey("next_up_clicked", { articleId: A, props: { target: "draft" } })).not.toBe(stepKey("next_up_clicked", { articleId: A, props: { target: "more" } }));
  });
});

describe("viewportOf", () => {
  it("buckets the width at the gate's breakpoints", () => {
    expect(viewportOf(375)).toBe("mobile");
    expect(viewportOf(639)).toBe("mobile");
    expect(viewportOf(640)).toBe("tablet");
    expect(viewportOf(1023)).toBe("tablet");
    expect(viewportOf(1024)).toBe("desktop");
    expect(viewportOf(Number.NaN)).toBe("mobile");
  });
});

describe("openedFrom", () => {
  const ORIGIN = "https://app.example";
  it("names the app page before the editor by its section, never its path", () => {
    expect(openedFrom("/onboarding", "", ORIGIN)).toBe("setup");
    expect(openedFrom("/checkout/success", "", ORIGIN)).toBe("setup");
    expect(openedFrom("/dashboard", "", ORIGIN)).toBe("dashboard");
    expect(openedFrom("/articles?status=review", "", ORIGIN)).toBe("articles");
    expect(openedFrom("/content/abc", "", ORIGIN)).toBe("article");
    expect(openedFrom("/settings/billing", "", ORIGIN)).toBe("app");
  });

  it("falls back to the referrer: another site is external, none is direct", () => {
    expect(openedFrom(null, "", ORIGIN)).toBe("direct");
    expect(openedFrom(null, "https://mail.example/inbox/123", ORIGIN)).toBe("external");
    expect(openedFrom(null, `${ORIGIN}/articles`, ORIGIN)).toBe("articles");
    expect(openedFrom(null, "not a url", ORIGIN)).toBe("direct");
  });
});

describe("uuidOrUndefined", () => {
  it("passes an id and nothing else", () => {
    expect(uuidOrUndefined("11111111-2222-4333-8444-555555555555")).toBe("11111111-2222-4333-8444-555555555555");
    expect(uuidOrUndefined("someone@acme.example")).toBeUndefined();
    expect(uuidOrUndefined(42)).toBeUndefined();
  });
});

// What came after "Start trial": a click that died inside Embedded Checkout
// used to leave no cause on our side.
describe("the trial steps", () => {
  const S = "cs_test_a1B2c3D4e5F6g7H8i9J0";

  it("say which button, plan and interval was pressed, from closed lists", () => {
    expect(stepProps("trial_clicked", { surface: "sticky_bar", plan: "growth", interval: "year" })).toEqual({ surface: "sticky_bar", plan: "growth", interval: "year" });
    expect(stepProps("trial_clicked", { surface: "publish_panel", plan: "enterprise", interval: "week" })).toEqual({});
    expect(stepProps("checkout_closed", { how: "backdrop", surface: "quiet_box", viewport: "mobile" })).toEqual({ how: "backdrop", surface: "quiet_box", viewport: "mobile" });
    expect(stepProps("checkout_closed", { how: "swiped away" })).toEqual({});
    expect(stepProps("checkout_failed", { stage: "load", surface: "articles", viewport: "desktop", message: "Stripe could not be loaded." })).toEqual({ stage: "load", surface: "articles", viewport: "desktop" });
    // A copy button is not a trial button, and the other way round.
    expect(stepProps("article_copied", { format: "html", surface: "price_box" })).toEqual({ format: "html" });
  });

  it("keep each button, plan and interval's click, and the old once-per-site click without one", () => {
    expect(stepKey("trial_clicked", {})).toBe("");
    expect(stepKey("trial_clicked", { props: { surface: "price_box", plan: "starter", interval: "month" } })).not.toBe(stepKey("trial_clicked", { props: { surface: "sticky_bar", plan: "starter", interval: "month" } }));
    expect(stepKey("trial_clicked", { props: { surface: "price_box", plan: "starter", interval: "month" } })).not.toBe(stepKey("trial_clicked", { props: { surface: "price_box", plan: "starter", interval: "year" } }));
  });

  it("keep a close and a failure per session, per button, per way, and one per way before there is a session", () => {
    const close = (how: "close" | "escape", checkoutId?: string) => stepKey("checkout_closed", { checkoutId, props: { how, surface: "price_box", viewport: "mobile" } });
    expect(close("close", S)).not.toBe(close("escape", S));
    expect(close("close", S)).not.toBe(close("close", "cs_test_other0000000000"));
    expect(close("close")).not.toBe(close("close", S));
    // The viewport says where, not which: the same close on a turned phone is the same close.
    expect(close("close", S)).toBe(stepKey("checkout_closed", { checkoutId: S, props: { how: "close", surface: "price_box", viewport: "tablet" } }));
    expect(stepKey("checkout_failed", { props: { stage: "create", surface: "billing" } })).not.toBe(stepKey("checkout_failed", { props: { stage: "load", surface: "billing" } }));
  });

  it("take a Stripe Checkout Session id and nothing else as the session", () => {
    expect(checkoutSessionOrUndefined(S)).toBe(S);
    expect(checkoutSessionOrUndefined("cs_live_a1B2c3D4e5F6g7H8i9J0")).toBe("cs_live_a1B2c3D4e5F6g7H8i9J0");
    expect(checkoutSessionOrUndefined(`${S}_secret_abc`)).toBeUndefined();
    expect(checkoutSessionOrUndefined("someone@acme.example")).toBeUndefined();
    expect(checkoutSessionOrUndefined("11111111-2222-4333-8444-555555555555")).toBeUndefined();
    expect(checkoutSessionOrUndefined(42)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { SETUP_ENDINGS, openedFrom, stepKey, stepProps, uuidOrUndefined, viewportOf } from "../step-props";

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

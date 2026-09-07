import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EXPLAINERS, MIN_BULLETS, MAX_BULLETS, CANNOT_YET_HEADING } from "@/lib/explainers";
import { HowItWorks } from "@/components/dashboard/how-it-works";

/**
 * The two rules every explainer is held to (lib/explainers/types.ts), plus a
 * guard against the one sentence this product must never say about itself.
 */
describe("explainers", () => {
  it("has unique ids and at least one section each", () => {
    const ids = EXPLAINERS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of EXPLAINERS) {
      expect(e.sections.length, e.id).toBeGreaterThan(0);
      expect(e.title.trim(), e.id).not.toBe("");
      expect(e.intro.trim(), e.id).not.toBe("");
      expect(e.mountsAt.trim(), e.id).not.toBe("");
    }
  });

  it("gives every section a title, a lead and three to five bullets", () => {
    for (const e of EXPLAINERS) {
      for (const s of e.sections) {
        const where = `${e.id} / ${s.title}`;
        expect(s.title.trim(), where).not.toBe("");
        expect(s.lead.trim(), where).not.toBe("");
        expect(s.bullets.length, where).toBeGreaterThanOrEqual(MIN_BULLETS);
        expect(s.bullets.length, where).toBeLessThanOrEqual(MAX_BULLETS);
        for (const b of s.bullets) expect(b.trim(), where).not.toBe("");
      }
    }
  });

  it("ends every explainer with an honest, non-empty 'cannot do yet' block", () => {
    for (const e of EXPLAINERS) {
      expect(e.cannotYet.length, e.id).toBeGreaterThan(0);
      for (const gap of e.cannotYet) expect(gap.trim(), e.id).not.toBe("");
    }
  });

  it("never claims anything publishes without an approval on record", () => {
    // Narrowed 2026-09-07. This used to forbid /publishes automatically/ and
    // assert the review explainer's "There is no auto-publish path. Not a
    // hidden one, not a flag: it does not exist." Migration 079 shipped
    // exactly that flag (`workspaces.auto_approve`), so the test had stopped
    // protecting the invariant and started protecting a false sentence: it
    // would have failed anyone correcting the screen a suspicious buyer opens
    // to check this specific question.
    //
    // The invariant that is still true, and the one worth guarding, is the one
    // lib/publishing/core.ts enforces: a publish always carries `approved_by`.
    // A rule can supply it; nothing can skip it. So what is forbidden is the
    // claim that something ships with NO approval behind it, not the claim
    // that an approval can come from a rule.
    const forbidden = /publish(es|ed)? without (an? )?(approval|sign-?off)/i;
    for (const e of EXPLAINERS) {
      const text = [e.intro, ...e.sections.flatMap((s) => [s.lead, ...s.bullets]), ...e.cannotYet].join("\n");
      expect(text, e.id).not.toMatch(forbidden);
    }
  });

  it("does not tell the review screen that no automatic approval exists", () => {
    // The lead used to read "There is no auto-publish path. Not a hidden one,
    // not a flag: it does not exist." `workspaces.auto_approve` is that flag,
    // it is on by default for a workspace created at signup, and README.md
    // documents it. Guard the correction so it cannot silently come back.
    const review = EXPLAINERS.find((e) => e.id === "review");
    expect(review).toBeDefined();
    const text = review!.sections.flatMap((s) => [s.lead, ...s.bullets]).join("\n");
    expect(text).not.toContain("There is no auto-publish path");
    expect(text).not.toContain("it does not exist");
    // What is true, and what the screen must keep saying: both writers of an
    // approval, named.
    expect(text).toContain("approved_by");
    expect(text).toMatch(/rule a member turned on/i);
  });

  it("does not tell the review screen that in-place CMS updates are impossible", () => {
    // The bullet used to read "Adapters publish and unpublish; publishing
    // again creates a new post. In-place edits arrive with the WordPress
    // plugin (#71)." By then publishArticleCore already called
    // adapter.update() when one existed, six adapters implemented it, and the
    // plugin adapter was registered - so all three sentences were false.
    const review = EXPLAINERS.find((e) => e.id === "review");
    expect(review).toBeDefined();
    const gaps = review!.cannotYet.join("\n");
    expect(gaps).not.toContain("publishing again creates a new post");
    expect(gaps).not.toContain("arrive with the WordPress plugin");
    // What is still true: the seven adapters with no update call.
    expect(gaps).toContain("Shopify, Magento, Framer, Wix, Notion, HubSpot or WooCommerce");
  });

  it("renders the chip with a stable test id and the heading text in the dialog data", () => {
    // The dialog is portalled after mount, so a static render shows the chip
    // only; the heading itself is a constant the component and the test share.
    const html = renderToStaticMarkup(<HowItWorks explainer={EXPLAINERS[0]} />);
    expect(html).toContain(`data-testid="how-it-works-${EXPLAINERS[0].id}"`);
    expect(html).toContain("How it works");
    expect(CANNOT_YET_HEADING).toBe("What this cannot do yet");
  });
});

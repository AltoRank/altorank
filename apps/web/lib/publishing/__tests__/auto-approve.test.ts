import { describe, it, expect } from "vitest";
import { decideAutoApproval, type AutoApproveCandidate, type AutoApproveRule } from "../auto-approve";

const NOW = new Date("2026-09-08T10:00:00Z");

const rule: AutoApproveRule = {
  auto_approve: true,
  auto_approve_hold_hours: 24,
  auto_approve_min_seo: 70,
  auto_approve_min_aeo: null,
  auto_approve_set_by: "user-1",
};

/** A draft that should sail through: written two days ago, clean, scored 82. */
const clean: AutoApproveCandidate = {
  id: "a1",
  status: "review",
  held_by: null,
  auto_approve_after: "2026-09-07T10:00:00Z",
  created_at: "2026-09-06T10:00:00Z",
  seo_score: 82,
  aeo_score: 55,
  factCheckBlocker: null,
  auditFailures: [],
  needsPlan: false,
  hasDestination: true,
  ruleOwnerIsMember: true,
};

describe("decideAutoApproval", () => {
  it("approves a clean draft whose hold window has passed", () => {
    expect(decideAutoApproval(rule, clean, NOW)).toEqual({ approve: true });
  });

  it("does nothing when the workspace has the rule off", () => {
    const d = decideAutoApproval({ ...rule, auto_approve: false }, clean, NOW);
    expect(d.approve).toBe(false);
  });

  it("waits out the hold window", () => {
    const d = decideAutoApproval(rule, { ...clean, auto_approve_after: "2026-09-08T18:00:00Z" }, NOW);
    expect(d).toMatchObject({ approve: false, reason: expect.stringContaining("hold window ends") });
  });

  it("counts the hold from created_at when the draft predates the rule", () => {
    const early = { ...clean, auto_approve_after: null, created_at: "2026-09-08T00:00:00Z" }; // 10h ago
    expect(decideAutoApproval(rule, early, NOW).approve).toBe(false);
    const late = { ...clean, auto_approve_after: null, created_at: "2026-09-06T00:00:00Z" };
    expect(decideAutoApproval(rule, late, NOW).approve).toBe(true);
  });

  it("holds a draft when there is nowhere to publish it", () => {
    // Auto-approve writes `status = scheduled`; the publish cron then takes it
    // to publishArticleCore, which throws with no CMS connected and writes
    // `status = error`. Held in review instead. Measured on a live account
    // (2026-09-09): three drafts, no CMS connected, all three due to
    // auto-approve the next day.
    const d = decideAutoApproval(rule, { ...clean, hasDestination: false }, NOW);
    expect(d).toMatchObject({
      approve: false,
      reason: expect.stringContaining("no CMS connected"),
    });
  });

  it("checks the plan before the destination: no plan is the more basic answer", () => {
    const d = decideAutoApproval(rule, { ...clean, needsPlan: true, hasDestination: false }, NOW);
    expect(d).toMatchObject({ reason: expect.stringContaining("no active plan") });
  });

  it("still waits out the hold window before mentioning the missing CMS", () => {
    const d = decideAutoApproval(
      rule,
      { ...clean, hasDestination: false, auto_approve_after: "2026-09-08T18:00:00Z" },
      NOW,
    );
    expect(d).toMatchObject({ reason: expect.stringContaining("hold window ends") });
  });

  it("respects a human hold", () => {
    const d = decideAutoApproval(rule, { ...clean, held_by: "user-2" }, NOW);
    expect(d).toMatchObject({ approve: false, reason: "held by a person" });
  });

  it("only ever moves a draft in review", () => {
    expect(decideAutoApproval(rule, { ...clean, status: "approved" }, NOW).approve).toBe(false);
    expect(decideAutoApproval(rule, { ...clean, status: "draft" }, NOW).approve).toBe(false);
  });

  it("runs the same hard checks as the human approve action", () => {
    expect(decideAutoApproval(rule, { ...clean, needsPlan: true }, NOW)).toMatchObject({
      reason: expect.stringContaining("no active plan"),
    });
    expect(decideAutoApproval(rule, { ...clean, factCheckBlocker: "1 figure has no source" }, NOW)).toMatchObject({
      reason: "1 figure has no source",
    });
    expect(decideAutoApproval(rule, { ...clean, auditFailures: ["Internal link points at an unknown page"] }, NOW)).toMatchObject({
      reason: expect.stringContaining("audit: Internal link"),
    });
  });

  it("holds below the SEO floor and says both numbers", () => {
    const d = decideAutoApproval(rule, { ...clean, seo_score: 61 }, NOW);
    expect(d).toMatchObject({ approve: false, reason: "SEO score 61 is below the 70 this workspace requires" });
  });

  it("ignores AEO unless the workspace asked for it, then requires a measurement", () => {
    expect(decideAutoApproval(rule, { ...clean, aeo_score: null }, NOW).approve).toBe(true);
    const strict = { ...rule, auto_approve_min_aeo: 60 };
    expect(decideAutoApproval(strict, { ...clean, aeo_score: null }, NOW).approve).toBe(false);
    expect(decideAutoApproval(strict, { ...clean, aeo_score: 59 }, NOW).approve).toBe(false);
    expect(decideAutoApproval(strict, { ...clean, aeo_score: 60 }, NOW).approve).toBe(true);
  });

  it("refuses when the rule's owner is gone or was never recorded", () => {
    expect(decideAutoApproval(rule, { ...clean, ruleOwnerIsMember: false }, NOW)).toMatchObject({
      reason: expect.stringContaining("no longer a member"),
    });
    expect(decideAutoApproval({ ...rule, auto_approve_set_by: null }, clean, NOW).approve).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { decideAutoApproval, type AutoApproveCandidate, type AutoApproveRefusalKind, type AutoApproveRule } from "../auto-approve";
import {
  CLEAN_APPROVALS_FOR_SENSITIVE,
  amountOf,
  amountsIn,
  competitorsNamed,
  isCleanApproval,
  optedOut,
  pageTypeOf,
  pricesNotOnSite,
  type ExceptionFacts,
  type OptOutRule,
} from "../auto-approve-exceptions";

const NOW = new Date("2026-10-16T10:00:00Z");

const rule: AutoApproveRule = {
  auto_approve: true,
  auto_approve_hold_hours: 24,
  auto_approve_min_seo: 70,
  auto_approve_min_aeo: null,
  auto_approve_set_by: "user-1",
  auto_approve_exceptions: {},
};

/** Nothing fires: the site has history, the draft is plain. */
const quiet: ExceptionFacts = {
  firstDraftOnSite: false,
  sensitive: null,
  pricesNotOnSite: [],
  competitorsNamed: [],
  newPageType: null,
  failedPublishes: null,
  cleanApprovals: 0,
};

const clean: AutoApproveCandidate = {
  id: "a1",
  status: "review",
  held_by: null,
  auto_approve_after: "2026-10-15T09:00:00Z",
  created_at: "2026-10-14T09:00:00Z",
  seo_score: 82,
  aeo_score: 55,
  factCheckBlocker: null,
  auditFailures: [],
  needsPlan: false,
  hasDestination: true,
  ruleOwnerIsMember: true,
  exceptions: quiet,
};

const decide = (facts: Partial<ExceptionFacts>, exceptions: Record<string, unknown> = {}) =>
  decideAutoApproval({ ...rule, auto_approve_exceptions: exceptions }, { ...clean, exceptions: { ...quiet, ...facts } }, NOW);

describe("exception rules: one row per rule", () => {
  const rows: Array<{ name: string; facts: Partial<ExceptionFacts>; kind: AutoApproveRefusalKind; says: string }> = [
    { name: "first draft on the site", facts: { firstDraftOnSite: true }, kind: "first_draft", says: "first draft on this site" },
    { name: "health advice", facts: { sensitive: { kind: "health", evidence: 'the topic names "physiotherapy"' } }, kind: "sensitive", says: "health advice" },
    { name: "money advice", facts: { sensitive: { kind: "financial", evidence: 'the topic names "mortgage"' } }, kind: "sensitive", says: "money advice" },
    { name: "a price not on the site", facts: { pricesNotOnSite: ["£45"] }, kind: "price", says: "price not on your site: £45" },
    { name: "a named competitor", facts: { competitorsNamed: ["rivalphysio.co.uk"] }, kind: "competitor", says: "competitor: rivalphysio.co.uk" },
    { name: "a new page type", facts: { newPageType: "listicle · roundup" }, kind: "page_type", says: "never published: listicle · roundup" },
    { name: "two failed publishes", facts: { failedPublishes: { lastError: "401 Unauthorized" } }, kind: "publish_failures", says: "last two publishes on this site failed: 401 Unauthorized" },
  ];

  it.each(rows)("$name → $kind, with a reason and a fix", ({ facts, kind, says }) => {
    const d = decide(facts);
    expect(d).toMatchObject({ approve: false, kind, reason: expect.stringContaining(says) });
    if (!d.approve) expect(d.fix.length).toBeGreaterThan(10);
  });

  it("approves when nothing fires", () => {
    expect(decide({})).toEqual({ approve: true });
  });

  it("fires in order: first draft, sensitive, price, competitor, page type, failures", () => {
    const all: Partial<ExceptionFacts> = Object.assign({}, ...rows.map((r) => r.facts));
    const order: AutoApproveRefusalKind[] = [];
    let facts = { ...all };
    for (const key of ["firstDraftOnSite", "sensitive", "pricesNotOnSite", "competitorsNamed", "newPageType", "failedPublishes"] as const) {
      const d = decide(facts);
      if (!d.approve) order.push(d.kind);
      facts = { ...facts, [key]: quiet[key] };
    }
    expect(order).toEqual(["first_draft", "sensitive", "price", "competitor", "page_type", "publish_failures"]);
  });

  it("comes after the fact check and before the reviewer, audit and score checks", () => {
    const facts = decide({ firstDraftOnSite: true });
    expect(decideAutoApproval(rule, { ...clean, factCheckBlocker: "1 figure has no source", exceptions: { ...quiet, firstDraftOnSite: true } }, NOW)).toMatchObject({ kind: "facts" });
    expect(decideAutoApproval(rule, { ...clean, hasDestination: false, exceptions: { ...quiet, firstDraftOnSite: true } }, NOW)).toMatchObject({ kind: "no_destination" });
    expect(decideAutoApproval(rule, { ...clean, seo_score: 10, auditFailures: ["x"], exceptions: { ...quiet, firstDraftOnSite: true } }, NOW)).toMatchObject({ kind: "first_draft" });
    expect(facts).toMatchObject({ kind: "first_draft" });
  });

  it("fires nothing when a caller computed no facts", () => {
    expect(decideAutoApproval(rule, { ...clean, exceptions: undefined }, NOW)).toEqual({ approve: true });
  });
});

describe("opt-outs: one row per rule", () => {
  const unlocked = { cleanApprovals: CLEAN_APPROVALS_FOR_SENSITIVE };
  const rows: Array<{ rule: OptOutRule | "first_draft" | "facts" | "publish_failures"; facts: Partial<ExceptionFacts>; canTurnOff: boolean }> = [
    { rule: "sensitive", facts: { ...unlocked, sensitive: { kind: "legal", evidence: "e" } }, canTurnOff: true },
    { rule: "price", facts: { pricesNotOnSite: ["€99"] }, canTurnOff: true },
    { rule: "competitor", facts: { competitorsNamed: ["rival.com"] }, canTurnOff: true },
    { rule: "page_type", facts: { newPageType: "guide · comparison" }, canTurnOff: true },
    { rule: "first_draft", facts: { firstDraftOnSite: true }, canTurnOff: false },
    { rule: "publish_failures", facts: { failedPublishes: { lastError: null } }, canTurnOff: false },
  ];

  it.each(rows)("$rule off → approves: $canTurnOff", ({ rule: r, facts, canTurnOff }) => {
    expect(decide(facts).approve).toBe(false);
    expect(decide(facts, { [r]: false }).approve).toBe(canTurnOff);
  });

  it("the fact check cannot be turned off", () => {
    const d = decideAutoApproval(
      { ...rule, auto_approve_exceptions: { facts: false, price: false } },
      { ...clean, factCheckBlocker: "1 figure has no source" },
      NOW,
    );
    expect(d).toMatchObject({ kind: "facts" });
  });

  it("turning one rule off leaves the others on", () => {
    expect(decide({ pricesNotOnSite: ["£45"], competitorsNamed: ["rival.com"] }, { price: false })).toMatchObject({ kind: "competitor" });
  });

  it("reads only known rules set to exactly false", () => {
    expect([...optedOut({ price: false, competitor: "false", page_type: 0, first_draft: false, nonsense: false })]).toEqual(["price"]);
    expect(optedOut(null).size).toBe(0);
    expect(optedOut(["price"]).size).toBe(0);
  });
});

describe("the 5-clean-approvals gate on health, legal and money advice", () => {
  const sensitive = { kind: "health" as const, evidence: "e" };
  it.each([
    { clean: 0, approves: false },
    { clean: CLEAN_APPROVALS_FOR_SENSITIVE - 1, approves: false },
    { clean: CLEAN_APPROVALS_FOR_SENSITIVE, approves: true },
    { clean: CLEAN_APPROVALS_FOR_SENSITIVE + 3, approves: true },
  ])("opted out with $clean clean approvals → approves: $approves", ({ clean: n, approves }) => {
    expect(decide({ sensitive, cleanApprovals: n }, { sensitive: false }).approve).toBe(approves);
  });

  it("with enough clean approvals and no opt-out, still asks, and says it can be turned off", () => {
    const d = decide({ sensitive, cleanApprovals: CLEAN_APPROVALS_FOR_SENSITIVE });
    expect(d).toMatchObject({ kind: "sensitive", fix: expect.stringContaining("turn this rule off") });
  });

  it("the other opt-outs need no clean approvals", () => {
    expect(decide({ pricesNotOnSite: ["£45"], cleanApprovals: 0 }, { price: false }).approve).toBe(true);
  });
});

describe("every refusal carries a kind and a fix", () => {
  const cases: Array<[AutoApproveRefusalKind, AutoApproveRule, AutoApproveCandidate]> = [
    ["rule_off", { ...rule, auto_approve: false }, clean],
    ["rule_owner", { ...rule, auto_approve_set_by: null }, clean],
    ["rule_owner", rule, { ...clean, ruleOwnerIsMember: false }],
    ["not_in_review", rule, { ...clean, status: "draft" }],
    ["held", rule, { ...clean, held_by: "u2" }],
    ["hold_window", rule, { ...clean, auto_approve_after: "2026-10-17T00:00:00Z" }],
    ["no_plan", rule, { ...clean, needsPlan: true }],
    ["no_destination", rule, { ...clean, hasDestination: false }],
    ["facts", rule, { ...clean, factCheckBlocker: "x" }],
    ["reviewer", rule, { ...clean, reviewerToConfirm: "Sam" }],
    ["audit", rule, { ...clean, auditFailures: ["x"] }],
    ["seo_floor", rule, { ...clean, seo_score: 10 }],
    ["aeo_floor", { ...rule, auto_approve_min_aeo: 90 }, clean],
  ];
  it.each(cases)("%s", (kind, r, a) => {
    const d = decideAutoApproval(r, a, NOW);
    expect(d).toMatchObject({ approve: false, kind });
    if (!d.approve) {
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.fix.length).toBeGreaterThan(0);
    }
  });
});

describe("price facts", () => {
  it.each([
    ["£45", 45],
    ["$1,500", 1500],
    ["€1.500,50", 1500.5],
    ["$1,500.50", 1500.5],
    ["1.500 €", 1500],
    ["45 TL", 45],
    ["$2 million", 2],
  ])("%s reads as %d", (figure, n) => {
    expect(amountOf(figure)).toBe(n);
  });

  it("a price the site states in another format is on the site", () => {
    const site = amountsIn("Initial assessment £45.00 · Follow-up 40 · Founded 2014");
    expect(pricesNotOnSite(["£45", "€40", "£60"], site)).toEqual(["£60"]);
  });
});

describe("competitor facts", () => {
  const competitors = ["rival-physio.co.uk", "seo.com"];
  it("finds a rival by its host, its name, or a link", () => {
    expect(competitorsNamed({ html: "<p>Unlike Rival Physio, we…</p>", keyword: "knee pain", competitors })).toEqual(["rival-physio.co.uk"]);
    expect(competitorsNamed({ html: "<p>See rival-physio.co.uk</p>", keyword: "knee pain", competitors })).toEqual(["rival-physio.co.uk"]);
    expect(competitorsNamed({ html: '<p><a href="https://www.rival-physio.co.uk/prices">prices</a></p>', keyword: "x", competitors })).toEqual(["rival-physio.co.uk"]);
  });

  it("finds a one-word domain name written as two words", () => {
    expect(competitorsNamed({ html: "<p>North Beans sells a kit.</p>", keyword: "pour over", competitors: ["northbeans.co.uk"] })).toEqual(["northbeans.co.uk"]);
    expect(competitorsNamed({ html: "<p>Go north. Beans matter.</p>", keyword: "x", competitors: ["northbeansshop.com"] })).toEqual([]);
  });

  it("does not match a one-word name that is the article's own keyword", () => {
    expect(competitorsNamed({ html: "<p>Ten SEO tips for clinics</p>", keyword: "seo tips", competitors })).toEqual([]);
    expect(competitorsNamed({ html: "<p>We compared seo.com</p>", keyword: "seo tips", competitors })).toEqual(["seo.com"]);
  });

  it("finds a rival the owner named without a domain", () => {
    expect(competitorsNamed({ html: "<p>The Bridge Street Clinic charges more.</p>", keyword: "x", competitors: [], names: ["Bridge Street Clinic"] })).toEqual(["Bridge Street Clinic"]);
  });

  it("does not match inside another word", () => {
    expect(competitorsNamed({ html: "<p>arrival physiology</p>", keyword: "x", competitors: ["rival-physio.co.uk"] })).toEqual([]);
  });
});

describe("page type and clean approvals", () => {
  it("labels a page type", () => {
    expect(pageTypeOf("listicle", "roundup")).toBe("listicle · roundup");
    expect(pageTypeOf("guide", null)).toBe("guide");
    expect(pageTypeOf(null, "howTo")).toBeNull();
  });

  const base = { status: "live", approval_kind: "human", approved_at: "2026-10-10T10:00:00Z", published_at: "2026-10-11T10:00:00Z", person_edited_at: null };
  it.each([
    ["approved by a person, live, never edited", base, true],
    ["edited after it went live", { ...base, person_edited_at: "2026-10-12T10:00:00Z" }, true],
    ["edited before it went out", { ...base, person_edited_at: "2026-10-09T10:00:00Z" }, false],
    ["approved before edits were recorded", { ...base, person_edited_at: "-infinity" }, false],
    ["approved by the rule, not a person", { ...base, approval_kind: "auto" }, false],
    ["not live yet", { ...base, status: "scheduled" }, false],
  ])("%s → %s", (_name, row, expected) => {
    expect(isCleanApproval(row)).toBe(expected);
  });
});

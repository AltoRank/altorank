import { describe, it, expect } from "vitest";
import type { ReadinessFinding, ReadinessResult } from "@/lib/audit/agent-readiness";
import { shapePublicCheck, badgeText, CHECK_ORDER, shareUrlFor, scoreLabel } from "../shape";

const AT = new Date("2026-09-04T10:00:00Z");

const f = (
  check: ReadinessFinding["check"],
  passed: boolean,
  severity: ReadinessFinding["severity"],
  extra: Partial<ReadinessFinding> = {},
): ReadinessFinding => ({ check, passed, severity, detail: `${check} detail`, ...extra });

/** All nine, everything passing. */
const ALL_PASS: ReadinessFinding[] = [
  f("robots_reachable", true, "medium"),
  f("ai_crawlers_allowed", true, "high"),
  f("sitemap", true, "medium"),
  f("structured_data", true, "high"),
  f("entity_schema", true, "high"),
  f("machine_readable", true, "medium"),
  f("title_meta", true, "low"),
  f("single_h1", true, "low"),
  f("content_signals", true, "low"),
];

const result = (findings: ReadinessFinding[], extra: Partial<ReadinessResult> = {}): ReadinessResult => ({
  domain: "acme.example",
  findings,
  score: 0,
  ...extra,
});

describe("shapePublicCheck", () => {
  it("always returns nine checks in a fixed order", () => {
    const data = shapePublicCheck(result(ALL_PASS), AT);
    expect(data.checks.map((c) => c.id)).toEqual(CHECK_ORDER);
    expect(data.total).toBe(9);
    expect(data.known).toBe(9);
    expect(data.passed).toBe(9);
    expect(data.score).toBe(100);
    expect(data.partial).toBe(false);
    expect(data.checked_at).toBe("2026-09-04T10:00:00.000Z");
    expect(data.share_url).toBe("https://app.altorank.co/check/acme.example");
  });

  it("carries evidence on pass and fail, and a fix line only on fail", () => {
    const findings = ALL_PASS.map((x) =>
      x.check === "entity_schema" ? { ...x, passed: false, detail: "no Organization schema" } : x,
    );
    const data = shapePublicCheck(result(findings), AT);
    const entity = data.checks.find((c) => c.id === "entity_schema")!;
    expect(entity.status).toBe("fail");
    expect(entity.evidence).toBe("no Organization schema");
    expect(entity.fix_summary).toMatch(/Organization/);
    const robots = data.checks.find((c) => c.id === "robots_reachable")!;
    expect(robots.status).toBe("pass");
    expect(robots.fix_summary).toBe("");
    // high=3 lost out of 18 weight points: 15/18
    expect(data.score).toBe(83);
  });

  it("marks checks the run never reached as unknown and scores only the rest (rule 5)", () => {
    // Deadline after the first three findings.
    const partial = result(ALL_PASS.slice(0, 3), { partial: true });
    const data = shapePublicCheck(partial, AT);
    expect(data.partial).toBe(true);
    expect(data.known).toBe(3);
    expect(data.checks.filter((c) => c.status === "unknown")).toHaveLength(6);
    expect(data.checks.find((c) => c.id === "structured_data")).toMatchObject({
      status: "unknown",
      evidence: "",
      fix_summary: "",
    });
    expect(data.score).toBe(100);
  });

  it("treats an inconclusive finding as unknown regardless of its passed flag", () => {
    const findings = ALL_PASS.map((x) =>
      x.check === "robots_reachable"
        ? { ...x, passed: false, inconclusive: true, detail: "server returned 503 for /robots.txt, not conclusive" }
        : x.check === "ai_crawlers_allowed"
          ? { ...x, passed: true, inconclusive: true }
          : x,
    );
    const data = shapePublicCheck(result(findings), AT);
    expect(data.checks.find((c) => c.id === "robots_reachable")).toMatchObject({
      status: "unknown",
      evidence: expect.stringContaining("not conclusive"),
    });
    expect(data.checks.find((c) => c.id === "ai_crawlers_allowed")?.status).toBe("unknown");
    expect(data.known).toBe(7);
    expect(data.passed).toBe(7);
    // The unknown ones are excluded from the score rather than counted as 0.
    expect(data.score).toBe(100);
  });

  it("has a null score, not zero, when nothing completed", () => {
    const data = shapePublicCheck(result([], { error: "unreachable over https" }), AT);
    expect(data.score).toBeNull();
    expect(data.known).toBe(0);
    expect(data.error).toBe("unreachable over https");
    expect(data.checks.every((c) => c.status === "unknown")).toBe(true);
  });
});

describe("badgeText", () => {
  const base = { total: 9, checked_at: "2026-09-04T10:00:00Z" };

  it("shows passed/total with the date when all nine ran", () => {
    expect(badgeText({ ...base, passed: 7, known: 9 })).toBe("AI-readiness: 7/9 · checked 4 Sep 2026");
  });

  it("shows passed/known and says so when a check could not be decided", () => {
    expect(badgeText({ ...base, passed: 7, known: 8 })).toBe("AI-readiness: 7/8, 1 not checked · checked 4 Sep 2026");
  });

  it("carries no number before a measurement exists", () => {
    expect(badgeText({ ...base, passed: 0, known: 0 })).toBe("AI-readiness check by AltoRank");
    expect(badgeText({ ...base, passed: 9, known: 9, error: "unreachable over https" })).toBe("AI-readiness check by AltoRank");
  });
});

describe("helpers", () => {
  it("encodes the domain in the share url", () => {
    expect(shareUrlFor("bücher.example", "http://localhost:3109")).toBe("http://localhost:3109/check/b%C3%BCcher.example");
  });

  it("labels a null score as not measured", () => {
    expect(scoreLabel(null)).toBe("Not measured");
    expect(scoreLabel(100)).toBe("Readable");
    expect(scoreLabel(10)).toBe("Hard to read");
  });
});

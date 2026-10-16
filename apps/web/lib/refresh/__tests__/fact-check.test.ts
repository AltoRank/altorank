import { describe, it, expect } from "vitest";
import { rewriteFactCheck, storedFactCheck } from "../fact-check";
import type { FactCheckReport, ExtractedClaim } from "@/lib/ai/fact-check";

const claim = (status: ExtractedClaim["status"], severity: ExtractedClaim["severity"]) =>
  ({ id: status, kind: "statistic", status, severity, text: "1", figures: ["1"], sentence: "s", attribution: null, sourceUrl: null, note: "" }) as ExtractedClaim;

function report(verdict: FactCheckReport["verdict"], claims: ExtractedClaim[], unchecked?: FactCheckReport["unchecked"]): FactCheckReport {
  const counts = {
    high: claims.filter((c) => c.severity === "high").length,
    medium: claims.filter((c) => c.severity === "medium").length,
    low: claims.filter((c) => c.severity === "low").length,
    total: claims.length,
  };
  return { verdict, claims, counts, summary: "", ...(unchecked ? { unchecked } : {}) };
}

describe("rewriteFactCheck", () => {
  it("counts the claims to correct when high risk, and the unverified ones when in review", () => {
    expect(rewriteFactCheck(report("high_risk", [claim("unsourced", "high"), claim("needs_verification", "medium")]))).toEqual({
      verdict: "high_risk",
      flagged: 1,
    });
    expect(rewriteFactCheck(report("review", [claim("verified", "low"), claim("needs_verification", "medium")]))).toEqual({
      verdict: "review",
      flagged: 1,
    });
  });

  it("flags nothing when clean, and keeps why an unchecked text was not checked", () => {
    expect(rewriteFactCheck(report("clean", [claim("verified", "low")]))).toEqual({ verdict: "clean", flagged: 0 });
    expect(rewriteFactCheck(report("unchecked", [], "language"))).toEqual({ verdict: "unchecked", flagged: 0, unchecked: "language" });
  });
});

describe("storedFactCheck", () => {
  it("reads the full report, falls back to the bare verdict of older rows, and returns null otherwise", () => {
    const r = report("review", [claim("needs_verification", "medium")]);
    expect(storedFactCheck({ factCheck: "review", factCheckReport: r })).toEqual({ report: r, verdict: "review" });
    expect(storedFactCheck({ factCheck: "high_risk" })).toEqual({ report: null, verdict: "high_risk" });
    expect(storedFactCheck({ factCheck: "nonsense" })).toBeNull();
    expect(storedFactCheck(null)).toBeNull();
  });
});

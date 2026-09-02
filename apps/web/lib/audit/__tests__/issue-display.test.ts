import { describe, it, expect } from "vitest";
import type { AuditIssue } from "@/lib/types";
import {
  affectedPageCount,
  auditDuration,
  formatPageSpeed,
  issueLabel,
  issueSeverity,
  issueUrl,
  pagespeedRows,
  sortIssues,
} from "@/lib/audit/issue-display";

/**
 * Deliberately typed loosely rather than as `Partial<AuditIssue>`.
 *
 * The cases worth testing here are the ones the declared type forbids and the
 * database contains anyway - severity "high", a `page` where `url` belongs -
 * so a fixture constrained to `AuditIssue` could not express the bug the
 * functions under test exist to absorb.
 */
function issue(partial: Record<string, unknown>): AuditIssue {
  return {
    type: "missing_meta",
    severity: "warning",
    url: "https://example.com/",
    message: "",
    ...partial,
  } as unknown as AuditIssue;
}

describe("issueSeverity", () => {
  it("passes through the severities the checks actually write", () => {
    expect(issueSeverity(issue({ severity: "error" }))).toBe("error");
    expect(issueSeverity(issue({ severity: "warning" }))).toBe("warning");
    expect(issueSeverity(issue({ severity: "info" }))).toBe("info");
  });

  it('reads the worker\'s "high" as an error', () => {
    // app/api/audit/route.ts writes its fetch-failure issue with severity
    // "high", which is outside the declared union. Unmapped it counted as
    // neither error nor warning, so a site that could not be fetched at all
    // reported "None" in the issues column.
    expect(issueSeverity(issue({ type: "fetch_failed", severity: "high" }))).toBe("error");
  });

  it("falls back to info rather than dropping an unknown severity", () => {
    expect(issueSeverity(issue({ severity: "spicy" }))).toBe("info");
  });
});

describe("issueUrl", () => {
  it("reads the url the checks write", () => {
    expect(issueUrl(issue({ url: "https://example.com/a" }))).toBe("https://example.com/a");
  });

  it("reads the page the worker writes instead", () => {
    expect(
      issueUrl(issue({ url: undefined, page: "https://example.com/" })),
    ).toBe("https://example.com/");
  });

  it("returns empty rather than undefined when neither is present", () => {
    expect(issueUrl(issue({ url: undefined }))).toBe("");
  });
});

describe("sortIssues", () => {
  it("puts errors first and info last, without mutating the input", () => {
    const input = [
      issue({ type: "missing_alt", severity: "info" }),
      issue({ type: "missing_meta", severity: "warning" }),
      issue({ type: "broken_link", severity: "error" }),
    ];
    const order = sortIssues(input).map((i) => i.severity);
    expect(order).toEqual(["error", "warning", "info"]);
    // The page renders counts off the original array; re-ordering it in place
    // would be a surprising side effect of displaying it.
    expect(input[0].severity).toBe("info");
  });

  it("ranks a fetch failure with the errors", () => {
    const sorted = sortIssues([
      issue({ type: "missing_meta", severity: "warning" }),
      issue({ type: "fetch_failed", severity: "high" }),
    ]);
    expect(sorted[0].type).toBe("fetch_failed");
  });
});

describe("affectedPageCount", () => {
  it("counts a page once however many issues it has", () => {
    expect(
      affectedPageCount([
        issue({ url: "https://example.com/a" }),
        issue({ url: "https://example.com/a" }),
        issue({ url: "https://example.com/b" }),
      ]),
    ).toBe(2);
  });

  it("ignores issues that name no page", () => {
    expect(affectedPageCount([issue({ url: undefined })])).toBe(0);
  });
});

describe("issueLabel", () => {
  it("turns the stored type into something a person reads", () => {
    expect(issueLabel("missing_alt")).toBe("Missing alt");
    expect(issueLabel("heading_hierarchy")).toBe("Heading hierarchy");
  });
});

describe("auditDuration", () => {
  const started = "2026-09-02T10:00:00.000Z";

  it("is null while the run is still going", () => {
    expect(auditDuration({ started_at: started, completed_at: null })).toBeNull();
  });

  it("reports sub-second, seconds and minutes", () => {
    expect(auditDuration({ started_at: started, completed_at: "2026-09-02T10:00:00.400Z" })).toBe("400ms");
    expect(auditDuration({ started_at: started, completed_at: "2026-09-02T10:00:42.000Z" })).toBe("42s");
    expect(auditDuration({ started_at: started, completed_at: "2026-09-02T10:02:05.000Z" })).toBe("2m 5s");
  });

  it("returns null rather than a negative duration on clock skew", () => {
    expect(auditDuration({ started_at: started, completed_at: "2026-09-02T09:59:00.000Z" })).toBeNull();
  });
});

describe("formatPageSpeed", () => {
  it("rounds a score and keeps CLS at three places", () => {
    expect(formatPageSpeed(87.6, "score")).toBe("88");
    // Rounded like a timing, every real CLS would print as 0.
    expect(formatPageSpeed(0.042, "raw")).toBe("0.042");
  });

  it("switches from milliseconds to seconds at a second", () => {
    expect(formatPageSpeed(940, "ms")).toBe("940ms");
    expect(formatPageSpeed(2400, "ms")).toBe("2.4s");
  });
});

describe("pagespeedRows", () => {
  it("returns nothing when PageSpeed was unavailable", () => {
    // The column is {} whenever the API was unconfigured, over quota, or could
    // not analyse the site.
    expect(pagespeedRows({})).toEqual([]);
    expect(pagespeedRows(null)).toEqual([]);
  });

  it("keeps only the numeric fields that are present", () => {
    const rows = pagespeedRows({
      performanceScore: 91,
      largestContentfulPaint: 1800,
      cumulativeLayoutShift: "nope",
    });
    expect(rows.map((r) => r.key)).toEqual(["performanceScore", "largestContentfulPaint"]);
    expect(rows[0].value).toBe(91);
  });
});

import { describe, expect, it } from "vitest";
import { inspectionFrom, parseInspection } from "../inspection";
import { coverageBucket } from "@/lib/gsc/analysis";

const AT = "2026-09-04T10:00:00.000Z";

describe("parseInspection", () => {
  it("lifts the index status fields and keeps the deep link", () => {
    const i = parseInspection(
      {
        inspectionResult: {
          inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=sc-domain:a.co&id=x",
          indexStatusResult: {
            verdict: "PASS",
            coverageState: "Submitted and indexed",
            robotsTxtState: "ALLOWED",
            indexingState: "INDEXING_ALLOWED",
            lastCrawlTime: "2026-09-01T03:12:00Z",
            pageFetchState: "SUCCESSFUL",
            googleCanonical: "https://a.co/x",
            userCanonical: "https://a.co/x",
            crawledAs: "MOBILE",
          },
        },
      },
      AT,
    );
    expect(i).toEqual({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
      lastCrawlTime: "2026-09-01T03:12:00Z",
      googleCanonical: "https://a.co/x",
      userCanonical: "https://a.co/x",
      crawledAs: "MOBILE",
      inspectionLink: "https://search.google.com/search-console/inspect?resource_id=sc-domain:a.co&id=x",
      checkedAt: AT,
    });
    expect(coverageBucket(i, false)).toBe("indexed");
  });

  it("leaves what Google did not say as null, never as a default", () => {
    const i = parseInspection({ inspectionResult: { indexStatusResult: { verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" } } }, AT);
    expect(i.verdict).toBe("NEUTRAL");
    expect(i.lastCrawlTime).toBeNull();
    expect(i.googleCanonical).toBeNull();
    expect(coverageBucket(i, true)).toBe("not_indexed");
  });

  it("survives an empty or malformed body", () => {
    expect(parseInspection({}, AT).verdict).toBeNull();
    expect(parseInspection(null, AT).checkedAt).toBe(AT);
    expect(coverageBucket(parseInspection("nonsense", AT), false)).toBe("unknown");
  });
});

describe("inspectionFrom", () => {
  it("reads the inspection member out of indexing_status and ignores the rest", () => {
    const stored = {
      indexnow: "submitted",
      google: "sitemap-resubmitted",
      inspection: { verdict: "PASS", coverageState: "Submitted and indexed", checkedAt: AT, inspectionLink: "https://x" },
    };
    const i = inspectionFrom(stored);
    expect(i?.verdict).toBe("PASS");
    expect(i?.checkedAt).toBe(AT);
    expect(i?.inspectionLink).toBe("https://x");
  });
  it("is null for statuses written before inspections existed", () => {
    expect(inspectionFrom({ indexnow: "no-key", google: "not-connected" })).toBeNull();
    expect(inspectionFrom(null)).toBeNull();
    expect(inspectionFrom({ inspection: { verdict: "PASS" } })).toBeNull();
  });
});

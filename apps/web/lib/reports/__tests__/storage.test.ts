import { describe, it, expect } from "vitest";
import { reportStoragePath, storagePathFromReportUrl } from "../storage";

describe("report storage paths", () => {
  it("puts the workspace in the second folder segment, which the storage policy reads", () => {
    expect(reportStoragePath("ws-1", "2026-08-01", "2026-08-31")).toBe("reports/ws-1/2026-08-01_2026-08-31.pdf");
  });

  it("returns a stored path as-is", () => {
    expect(storagePathFromReportUrl("reports/ws-1/2026-08-01_2026-08-31.pdf")).toBe("reports/ws-1/2026-08-01_2026-08-31.pdf");
  });

  /** Rows written before 066 hold the old public URL; the path is inside it. */
  it("recovers the path from a public or signed URL written before the bucket was private", () => {
    expect(
      storagePathFromReportUrl("https://x.supabase.co/storage/v1/object/public/reports/reports/ws-1/2026-08-01_2026-08-31.pdf"),
    ).toBe("reports/ws-1/2026-08-01_2026-08-31.pdf");
    expect(
      storagePathFromReportUrl("https://x.supabase.co/storage/v1/object/sign/reports/reports/ws-1/2026-08-01_2026-08-31.pdf?token=t"),
    ).toBe("reports/ws-1/2026-08-01_2026-08-31.pdf");
  });

  it("is null for nothing, or for a URL that is not a report", () => {
    expect(storagePathFromReportUrl(null)).toBeNull();
    expect(storagePathFromReportUrl("")).toBeNull();
    expect(storagePathFromReportUrl("https://example.com/other.pdf")).toBeNull();
  });
});

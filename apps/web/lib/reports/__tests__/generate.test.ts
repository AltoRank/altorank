import { describe, it, expect, vi, beforeEach } from "vitest";

// The PDF and the metrics are not under test; the storage contract is: a
// private bucket, the object path in the row, a signed link for the email.
vi.mock("@react-pdf/renderer", () => ({ renderToBuffer: async () => Buffer.from("%PDF") }));
vi.mock("../pdf-template", () => ({ ReportPDF: () => null }));
vi.mock("../metrics", () => ({
  aggregateReportData: async () => ({ articlesPublished: 2, ga4Summary: null, totalKeywords: 5 }),
}));

import { generateReport } from "../generate";

const calls: Record<string, unknown[]> = {};
let uploadError: { message: string } | null = null;
let signError: { message: string } | null = null;

function client() {
  const rec = (k: string, ...args: unknown[]) => (calls[k] ??= []).push(args);
  return {
    storage: {
      from: (bucket: string) => ({
        upload: async (...a: unknown[]) => {
          rec("upload", bucket, ...a);
          return { error: uploadError };
        },
        createSignedUrl: async (path: string, ttl: number) => {
          rec("sign", bucket, path, ttl);
          return signError
            ? { data: null, error: signError }
            : { data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t` }, error: null };
        },
      }),
    },
    from: () => ({
      upsert: (row: Record<string, unknown>) => {
        rec("upsert", row);
        return { select: () => ({ single: async () => ({ data: { id: "r1" }, error: null }) }) };
      },
    }),
  } as never;
}

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  uploadError = null;
  signError = null;
});

describe("generateReport", () => {
  it("uploads to the private bucket, stores the path, and returns a signed link for the email", async () => {
    const out = await generateReport(client(), "ws-1", "2026-08-01", "2026-08-31");
    expect(calls.upload![0]).toEqual([
      "reports",
      "reports/ws-1/2026-08-01_2026-08-31.pdf",
      expect.any(Buffer),
      { contentType: "application/pdf", upsert: true },
    ]);
    // Thirty days: long enough for the email, not a permanent public link.
    expect(calls.sign![0]).toEqual(["reports", "reports/ws-1/2026-08-01_2026-08-31.pdf", 30 * 24 * 60 * 60]);
    expect((calls.upsert![0] as [Record<string, unknown>])[0].url).toBe("reports/ws-1/2026-08-01_2026-08-31.pdf");
    expect(out).toEqual({ reportId: "r1", url: expect.stringContaining("/object/sign/reports/") });
    expect(out.url).not.toContain("/object/public/");
  });

  it("throws when the upload is refused, so a missing bucket is reported rather than a row with no file", async () => {
    uploadError = { message: "Bucket not found" };
    await expect(generateReport(client(), "ws-1", "2026-08-01", "2026-08-31")).rejects.toThrow("Upload failed: Bucket not found");
    expect(calls.upsert).toBeUndefined();
  });

  it("throws when the link cannot be signed", async () => {
    signError = { message: "Object not found" };
    await expect(generateReport(client(), "ws-1", "2026-08-01", "2026-08-31")).rejects.toThrow("Could not sign the report link");
    expect(calls.upsert).toBeUndefined();
  });
});

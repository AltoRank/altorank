import { expect, it } from "vitest";
import { parseCapabilities, supportedCapabilities } from "../profile-focus";
it("requires the quote on its cited page, and never trusts the model's confirmed label", () => {
  const quote = "Export your approved reports as a PDF.";
  const rows = parseCapabilities([
    { claim: "PDF export", sourceUrl: "https://example.com/features", quote, status: "confirmed" },
    { claim: "PDF export", sourceUrl: "https://example.com/pricing", quote, status: "confirmed" },
    { claim: "PDF export", sourceUrl: "https://outsider.com/features", quote },
  ], "example.com", `SOURCE https://example.com/features\n${quote}\n\nSOURCE https://example.com/pricing\nFree for one user.`);
  expect(rows.map((r) => r.status)).toEqual(["observed","inferred","inferred"]);
  expect(supportedCapabilities({ capabilities: rows })).toHaveLength(1);
});

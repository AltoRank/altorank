import { describe, it, expect } from "vitest";
import { assertEditorialStatus, EDITORIAL_STATUSES } from "../editorial-status";

describe("assertEditorialStatus", () => {
  it("accepts the editorial states", () => {
    for (const s of EDITORIAL_STATUSES) expect(() => assertEditorialStatus(s)).not.toThrow();
  });

  it("refuses every status the approval gate treats as a pass", () => {
    // "approved" alone satisfies publishArticleCore; "scheduled" does with approved_by.
    for (const s of ["approved", "scheduled", "live", "drafting", "error", "", undefined, null, 42]) {
      expect(() => assertEditorialStatus(s)).toThrow(/cannot be set from the editor/);
    }
  });
});

import { describe, it, expect } from "vitest";
import { siteContextFrom } from "../generate";

describe("siteContextFrom", () => {
  it("is undefined when there is no profile to speak of", () => {
    // Installs from before migration 048, or a wizard the owner skipped.
    expect(siteContextFrom(null)).toBeUndefined();
    expect(siteContextFrom(undefined)).toBeUndefined();
    expect(siteContextFrom("AltoRank")).toBeUndefined();
    expect(siteContextFrom({})).toBeUndefined();
    expect(siteContextFrom({ name: "  ", description: "", audiences: ["x"] })).toBeUndefined();
  });

  it("keeps the fields a writer can use, trimmed", () => {
    expect(
      siteContextFrom({
        name: " AltoRank ",
        description: " SEO content platform. ",
        audiences: [" Accounts ", "", 42, "Bloggers"],
        offerings: [" approval-first SEO drafts ", ""],
        competitors: ["semrush.com"],
        country: "Global (English)",
      }),
    ).toEqual({
      name: "AltoRank",
      description: "SEO content platform.",
      audiences: ["Accounts", "Bloggers"],
      offerings: ["approval-first SEO drafts"],
      confirmed: false,
    });
  });

  it("says whether a person confirmed the profile", () => {
    expect(siteContextFrom({ name: "AltoRank", confirmedAt: "2026-09-25T10:00:00.000Z" })?.confirmed).toBe(true);
    // The scheduled repair saves a model's reading with confirmedAt null.
    expect(siteContextFrom({ name: "AltoRank", confirmedAt: null })?.confirmed).toBe(false);
  });

  it("accepts a name without a description and the reverse", () => {
    expect(siteContextFrom({ name: "AltoRank" })).toEqual({ name: "AltoRank", description: null, audiences: [], offerings: [], confirmed: false });
    expect(siteContextFrom({ description: "A thing." })).toEqual({ name: null, description: "A thing.", audiences: [], offerings: [], confirmed: false });
  });
});

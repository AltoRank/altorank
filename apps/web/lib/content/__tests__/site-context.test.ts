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

  it("keeps the three fields a writer can use, trimmed", () => {
    expect(
      siteContextFrom({
        name: " AltoRank ",
        description: " SEO content platform. ",
        audiences: [" Agencies ", "", 42, "Bloggers"],
        competitors: ["semrush.com"],
        country: "Global (English)",
      }),
    ).toEqual({ name: "AltoRank", description: "SEO content platform.", audiences: ["Agencies", "Bloggers"] });
  });

  it("accepts a name without a description and the reverse", () => {
    expect(siteContextFrom({ name: "AltoRank" })).toEqual({ name: "AltoRank", description: null, audiences: [] });
    expect(siteContextFrom({ description: "A thing." })).toEqual({ name: null, description: "A thing.", audiences: [] });
  });
});

import { describe, it, expect } from "vitest";
import { audienceDoubt, doubtedAudiences } from "../audience-check";

describe("audienceDoubt", () => {
  it("names the seven values the first real signup typed, and why", () => {
    const typed = ["united states", "europe", "belgium", "hoodie", "clothing", "apparel", "custom print"];
    expect(typed.map(audienceDoubt)).toEqual(["place", "place", "place", "product", "product", "product", "product"]);
  });

  it("lets a phrase that names people through, even when it contains a place or a product", () => {
    for (const ok of [
      "Gift buyers looking for themed clothing",
      "Hoodie buyers in Belgium",
      "Content managers at B2B SaaS companies",
      "Pop culture and anime fans",
      "Small shops in the United States that print their own merch",
    ]) {
      expect(audienceDoubt(ok)).toBeNull();
    }
  });

  it("is case- and punctuation-insensitive, and ignores blanks", () => {
    expect(audienceDoubt("  United States. ")).toBe("place");
    expect(audienceDoubt("T-Shirts")).toBe("product");
    expect(audienceDoubt("")).toBeNull();
  });

  it("groups the doubted values for the note under the list", () => {
    expect(doubtedAudiences(["europe", "hoodie", "Anime fans", "apparel"])).toEqual({
      places: ["europe"],
      products: ["hoodie", "apparel"],
    });
  });
});

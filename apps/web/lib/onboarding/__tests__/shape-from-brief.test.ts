import { describe, expect, it } from "vitest";
import { shapeFromBrief } from "../plan";

describe("shapeFromBrief", () => {
  it("takes the brief's shape over the words of the query", () => {
    // The words say listicle ("software"); the results page said comparison.
    expect(shapeFromBrief("software gestione palestra", { status: "qualified", shape: "comparison" })).toEqual({ article_type: "guide", article_subtype: "comparison" });
  });
  it("lets the query decide which kind of list", () => {
    expect(shapeFromBrief("best gym software", { status: "qualified", shape: "listicle" })).toEqual({ article_type: "listicle", article_subtype: "resources" });
    expect(shapeFromBrief("gestionale palestra", { status: "qualified", shape: "listicle" })).toEqual({ article_type: "listicle", article_subtype: "roundup" });
  });
  it("is null without a qualified brief carrying a shape, so the regex still decides", () => {
    expect(shapeFromBrief("x", { status: "rejected", shape: "comparison" })).toBeNull();
    expect(shapeFromBrief("x", { status: "qualified" })).toBeNull();
    expect(shapeFromBrief("x", null)).toBeNull();
  });
});

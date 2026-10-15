import { describe, expect, it } from "vitest";
import { alternativeSeeds, rivalName } from "../alternative-seeds";

describe("rivalName", () => {
  it("is the name a buyer types, not the host", () => {
    expect(rivalName("acmegym-app.example")).toBe("acmegym");
    expect(rivalName("www.trainerize.com")).toBe("trainerize");
    expect(rivalName("distribb.io")).toBe("distribb");
  });
});

describe("alternativeSeeds", () => {
  it("asks for a substitute in the site's language and in English", () => {
    expect(alternativeSeeds(["acmegym-app.example"], "it")).toEqual([
      "alternativa acmegym", "alternative a acmegym", "acmegym alternative", "acmegym alternatives",
    ]);
  });
  it("does not double the English phrasings on an English site", () => {
    expect(alternativeSeeds(["distribb.io"], "en")).toEqual(["distribb alternative", "distribb alternatives"]);
  });
  it("falls back to English for a language it has no phrasing for", () => {
    expect(alternativeSeeds(["distribb.io"], "pl")).toEqual(["distribb alternative", "distribb alternatives"]);
  });
  it("de-duplicates across rivals and skips a name too short to be one", () => {
    expect(alternativeSeeds(["distribb.io", "www.distribb.io", "x.co"], "en")).toEqual(["distribb alternative", "distribb alternatives"]);
  });
});

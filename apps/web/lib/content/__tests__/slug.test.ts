import { describe, it, expect } from "vitest";
import { slugFor } from "../generate";

describe("slugFor", () => {
  it("keeps the letters of an accented keyword instead of deleting them", () => {
    // Before: "citt-d-arte" and "perch". The keyword's own letters were the
    // ones being dropped, on the Italian, French and German terms the
    // product writes for first.
    expect(slugFor("città d'arte perché")).toBe("citta-d-arte-perche");
    expect(slugFor("Übersicht für Anfänger")).toBe("ubersicht-fur-anfanger");
    expect(slugFor("Guía de SEO en español")).toBe("guia-de-seo-en-espanol");
  });

  it("is unchanged for plain ASCII", () => {
    expect(slugFor("How to Rank in ChatGPT: A Guide")).toBe("how-to-rank-in-chatgpt-a-guide");
    expect(slugFor("  --seo--  ")).toBe("seo");
  });
});

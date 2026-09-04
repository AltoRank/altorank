import { describe, expect, it } from "vitest";
import {
  cpcIndex,
  describeOrganicValue,
  estimateOrganicValue,
  formatOrganicValue,
  sumOrganicValues,
  valueLocale,
} from "../value";

/**
 * What is being protected is the boundary between "not measured" and
 * "measured, zero". Every surface renders null as an em dash and 0 as a
 * currency amount, so the function has to be exact about which it returns.
 */
describe("estimateOrganicValue", () => {
  const cpc = cpcIndex([
    { term: "warehouse orchestration", cpc: 4.2 },
    { term: "WMS Software", cpc: "12.50" },
  ]);

  it("is null, not zero, when nothing was measured", () => {
    const v = estimateOrganicValue([], cpc);
    expect(v.value).toBeNull();
    expect(v.clicks).toBe(0);
    expect(v.coverage).toBeNull();
  });

  it("is null when traffic was measured but no term has a CPC", () => {
    const v = estimateOrganicValue([{ term: "unpriced", clicks: 40 }], cpc);
    expect(v.value).toBeNull();
    // The clicks are still reported, so the caption can say what was seen.
    expect(v.clicks).toBe(40);
    expect(v.coverage).toBe(0);
  });

  it("is zero when priced terms were measured and nobody clicked", () => {
    // Search Console reports impressions-only rows with clicks: 0. That is a
    // measurement of the site, and it earns a number.
    const v = estimateOrganicValue([{ term: "warehouse orchestration", clicks: 0 }], cpc);
    expect(v.value).toBe(0);
    expect(v.valuedTerms).toBe(1);
    expect(v.coverage).toBeNull();
  });

  it("sums clicks × cpc per term, matching case-insensitively", () => {
    const v = estimateOrganicValue(
      [
        { term: "Warehouse Orchestration", clicks: 10 },
        { term: "warehouse orchestration ", clicks: 5 },
        { term: "wms software", clicks: 2 },
        { term: "unpriced long tail", clicks: 100 },
        { term: null, clicks: 3 },
      ],
      cpc,
    );
    expect(v.value).toBe(10 * 4.2 + 5 * 4.2 + 2 * 12.5);
    expect(v.clicks).toBe(120);
    expect(v.valuedClicks).toBe(17);
    expect(v.valuedTerms).toBe(2);
    expect(v.coverage).toBeCloseTo(17 / 120);
  });

  it("rounds to cents so float drift does not reach the page", () => {
    const idx = cpcIndex([{ term: "a", cpc: 0.1 }]);
    const v = estimateOrganicValue([{ term: "a", clicks: 3 }], idx);
    expect(v.value).toBe(0.3);
  });
});

describe("cpcIndex", () => {
  it("refuses 0 and null as prices", () => {
    // The research parser defaults a missing CPC to 0. Indexing that would
    // count a term's clicks as covered and worth nothing, which is a claim.
    const idx = cpcIndex([
      { term: "free", cpc: 0 },
      { term: "unknown", cpc: null },
      { term: "bad", cpc: "not a number" },
      { term: "negative", cpc: -1 },
      { term: "priced", cpc: 1 },
    ]);
    expect([...idx.keys()]).toEqual(["priced"]);
  });
});

describe("sumOrganicValues", () => {
  const priced = estimateOrganicValue([{ term: "a", clicks: 10 }], cpcIndex([{ term: "a", cpc: 2 }]));
  const unpriced = estimateOrganicValue([{ term: "b", clicks: 30 }], new Map());
  const unmeasured = estimateOrganicValue([], new Map());

  it("is unmeasured when every part is", () => {
    expect(sumOrganicValues([unmeasured, unmeasured]).value).toBeNull();
    expect(sumOrganicValues([]).coverage).toBeNull();
  });

  it("keeps a priced part's value and counts the unpriced part's clicks as uncovered", () => {
    const v = sumOrganicValues([priced, unpriced, unmeasured]);
    expect(v.value).toBe(20);
    expect(v.clicks).toBe(40);
    expect(v.coverage).toBeCloseTo(0.25);
  });

  it("stays null when parts measured traffic but none could price it", () => {
    const v = sumOrganicValues([unpriced, unpriced]);
    expect(v.value).toBeNull();
    expect(v.clicks).toBe(60);
  });
});

describe("formatOrganicValue", () => {
  it("renders null as an em dash, never $0", () => {
    expect(formatOrganicValue(null, "en")).toBe("—");
  });

  it("renders a measured zero as money", () => {
    expect(formatOrganicValue(0, "en")).toBe("$0.00");
  });

  it("writes dollars in the workspace locale", () => {
    // Same currency, different punctuation: the amount is USD everywhere
    // because that is what the provider quotes in.
    expect(formatOrganicValue(1234.5, "en")).toBe("$1,235");
    expect(formatOrganicValue(1234.5, "en-gb")).toMatch(/^US?\$1,235$/);
    // ICU separates symbol and amount with a non-breaking space; the
    // assertion cares about the grouping, not the whitespace codepoint.
    expect(formatOrganicValue(1234.5, "de").replace(/\s/g, " ")).toBe("1.235 $");
    expect(formatOrganicValue(1234.5, "it").replace(/\s/g, " ")).toBe("1235 USD");
  });

  it("keeps cents under a hundred", () => {
    expect(formatOrganicValue(4.2, "en")).toBe("$4.20");
    expect(formatOrganicValue(99.999, "en")).toBe("$100.00");
  });

  it("survives a locale Intl has never heard of", () => {
    expect(valueLocale("not a locale!!")).toBe("en");
    expect(valueLocale(null)).toBe("en");
    expect(valueLocale("pt-pt")).toBe("pt-PT");
    expect(formatOrganicValue(10, "??")).toBe("$10.00");
  });
});

describe("describeOrganicValue", () => {
  it("names the formula and the coverage", () => {
    const v = estimateOrganicValue(
      [{ term: "a", clicks: 10 }, { term: "b", clicks: 30 }],
      cpcIndex([{ term: "a", cpc: 2 }]),
    );
    const text = describeOrganicValue(v, 30);
    expect(text).toContain("last 30 days");
    expect(text).toContain("cost-per-click");
    expect(text).toContain("10 of 40 clicks (25%)");
  });

  it("says why there is no number", () => {
    expect(describeOrganicValue(estimateOrganicValue([], new Map()), 30)).toContain("Nothing is measured");
    expect(
      describeOrganicValue(estimateOrganicValue([{ term: "x", clicks: 5 }], new Map()), 30),
    ).toContain("has a cost-per-click on file yet");
  });
});

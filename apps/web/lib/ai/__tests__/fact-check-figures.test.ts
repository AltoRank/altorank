import { describe, it, expect } from "vitest";
import { factCheckArticle, approvalBlocker, dropCurrencyDuplicates } from "../fact-check";

// From a real article on 2026-09-03. One sentence of price ranges produced the
// figure list "$1,000, $9,999,, $10,000, $49,999,, 1,000, 9,999, 10,000,
// 49,999": trailing commas swallowed by the money pattern, and every number a
// second time without its currency symbol because the large-count pattern
// matched it too. The reviewer saw that verbatim in the refusal message.
const PRICES =
  "<h1>x</h1><p>Retainers run $1,000-$9,999, and enterprise work runs $10,000-$49,999, per month.</p>";

describe("fact check — figure extraction", () => {
  it("keeps the currency figures and nothing else, with no trailing punctuation", () => {
    const [claim] = factCheckArticle(PRICES).claims;
    expect(claim.figures).toEqual(["$1,000", "$9,999", "$10,000", "$49,999"]);
    expect(claim.text).toBe("$1,000, $9,999, $10,000, $49,999");
  });

  it("renders a refusal a person can read", () => {
    const msg = approvalBlocker(factCheckArticle(PRICES))!;
    expect(msg).toContain('"$1,000, $9,999, $10,000, $49,999"');
    expect(msg).not.toContain(",,");
  });

  it("still catches a bare grouped number that has no currency", () => {
    const claim = factCheckArticle("<h1>x</h1><p>We onboarded 12,000 customers.</p>").claims[0];
    expect(claim.figures).toEqual(["12,000"]);
  });

  it("does not eat a decimal or a trailing period", () => {
    const claim = factCheckArticle("<h1>x</h1><p>It costs $19.95. Cheap.</p>").claims[0];
    expect(claim.figures).toEqual(["$19.95"]);
  });

  it("keeps a multiplier suffix", () => {
    const claim = factCheckArticle("<h1>x</h1><p>They raised $5m last year.</p>").claims[0];
    expect(claim.figures).toEqual(["$5m"]);
  });
});

describe("dropCurrencyDuplicates", () => {
  it("drops the bare number only when the pair differs by a currency symbol", () => {
    expect(dropCurrencyDuplicates(["$1,000", "1,000"])).toEqual(["$1,000"]);
    expect(dropCurrencyDuplicates(["€2,500", "2,500"])).toEqual(["€2,500"]);
  });

  it("keeps two percentages where one merely ends with the other", () => {
    // A plain substring check ate "20%" out of "120%", which is a different
    // statistic and the reviewer needs both.
    expect(dropCurrencyDuplicates(["120%", "20%"])).toEqual(["120%", "20%"]);
    expect(dropCurrencyDuplicates(["$150", "50"])).toEqual(["$150", "50"]);
  });

  it("leaves an unrelated set alone", () => {
    expect(dropCurrencyDuplicates(["73%", "$19.95", "12,000"])).toEqual(["73%", "$19.95", "12,000"]);
  });
});

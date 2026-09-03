import { describe, it, expect } from "vitest";
import { factCheckArticle, approvalBlocker } from "../fact-check";

// Every rubric the product was compared against calls a fabricated statistic
// zero tolerance. The fact checker found them and the approve button ignored
// it. This is the message that button now gets.

describe("approvalBlocker", () => {
  it("refuses a draft that still carries bare figures, naming them", () => {
    const report = factCheckArticle(
      "<h1>x</h1><p>Around 73% of sites get this wrong, and 42% never fix it.</p>",
    );
    expect(report.verdict).toBe("high_risk");
    const msg = approvalBlocker(report)!;
    expect(msg).toContain("unsourced");
    expect(msg).toContain('"73%, 42%"');
    expect(msg).toContain("then approve");
  });

  it("lets a draft through when every figure is attributed or linked", () => {
    const report = factCheckArticle(
      '<h1>x</h1><p>According to Gartner, 73% of sites get this wrong.</p>' +
        '<p>42% never fix it, per <a href="https://litmus.com/r">Litmus</a>.</p>',
    );
    expect(report.verdict).toBe("review");
    expect(approvalBlocker(report)).toBeNull();
  });

  it("lets a draft with no figures through", () => {
    expect(approvalBlocker(factCheckArticle("<h1>x</h1><p>No numbers here.</p>"))).toBeNull();
  });
});

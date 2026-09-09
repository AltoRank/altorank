import { describe, it, expect } from "vitest";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import {
  verifyCitedFigures,
  figureVariants,
  pageHasFigure,
  readablePageText,
  type PageFetcher,
} from "../citation-check";

/**
 * The draft that motivated this: a real citation carrying a wrong number.
 *
 * qasimcode.com's article named the U.S. Bureau of Labor Statistics, linked to
 * the correct BLS page, and said "8 percent from 2023 to 2033". That page says
 * 5 percent from 2025 to 2035. Attributed, so `needs_verification` at medium,
 * so not a blocker, so one hold window from publishing itself.
 */
const BLS_URL = "https://www.bls.gov/ooh/computer-and-information-technology/web-developers.htm";

const ARTICLE = (figure: string) =>
  `<p>According to the Bureau of Labor Statistics, employment of web developers` +
  ` and digital designers is projected to grow ${figure} from 2025 to 2035, faster` +
  ` than the average for all occupations. <a href="${BLS_URL}">BLS</a></p>`;

/** What the BLS page actually says, padded past the readability floor. */
const BLS_PAGE =
  "<html><body><p>Overall employment of web developers and digital designers is " +
  "projected to grow 5 percent from 2025 to 2035, faster than the average for all " +
  "occupations.</p>" +
  `<p>${"Median pay was $99,520 per year. ".repeat(20)}</p></body></html>`;

const serve = (body: string, status = 200): PageFetcher => async () => ({ status, body });
const never: PageFetcher = async () => {
  throw new Error("should not have been fetched");
};

describe("verifyCitedFigures — the figure the cited page does not carry", () => {
  it("catches a wrong number behind a real citation", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE("8 percent")), {
      fetcher: serve(BLS_PAGE),
    });
    expect(report.claims[0].status).toBe("contradicted");
    expect(report.claims[0].severity).toBe("high");
  });

  it("blocks the publish it used to sail through", async () => {
    const before = factCheckArticle(ARTICLE("8 percent"));
    expect(before.verdict).toBe("review");
    expect(approvalBlocker(before)).toBeNull();

    const after = await verifyCitedFigures(before, { fetcher: serve(BLS_PAGE) });
    expect(after.verdict).toBe("high_risk");
    expect(approvalBlocker(after)).toContain("not on the page the draft cites");
  });

  it("names the figure and the page, so the fix is one click", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE("8 percent")), {
      fetcher: serve(BLS_PAGE),
    });
    expect(report.claims[0].note).toContain("8 percent");
    expect(report.claims[0].note).toContain(BLS_URL);
  });

  it("clears the same sentence once the figure matches the source", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE("5 percent")), {
      fetcher: serve(BLS_PAGE),
    });
    expect(report.claims[0].status).toBe("verified");
    expect(report.claims[0].severity).toBe("low");
    expect(report.verdict).toBe("review");
    expect(approvalBlocker(report)).toBeNull();
  });

  it("does not call a verified figure proven", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE("5 percent")), {
      fetcher: serve(BLS_PAGE),
    });
    expect(report.claims[0].note).toContain("not proof");
  });
});

describe("verifyCitedFigures — silence is never evidence", () => {
  const cases: [string, PageFetcher][] = [
    ["a WAF or a paywall", serve(BLS_PAGE, 403)],
    ["a page that fills itself in with script", serve("<html><body><div id=root></div></body></html>")],
    ["a PDF the checker cannot read", serve("")],
    ["a host that never answers", async () => { throw new Error("ETIMEDOUT"); }],
  ];

  for (const [what, fetcher] of cases) {
    it(`leaves the claim for a person when the source is ${what}`, async () => {
      const report = await verifyCitedFigures(factCheckArticle(ARTICLE("8 percent")), { fetcher });
      expect(report.claims[0].status).toBe("needs_verification");
      expect(report.claims[0].severity).toBe("medium");
      expect(report.verdict).toBe("review");
    });
  }
});

describe("verifyCitedFigures — what it declines to touch", () => {
  it("never opens a link to a private host", async () => {
    const html = `<p>Some 42% of clinics, per Acme's report. <a href="http://10.0.0.5/x">Acme</a></p>`;
    const report = await verifyCitedFigures(factCheckArticle(html), { fetcher: never });
    expect(report.claims[0].status).toBe("needs_verification");
  });

  it("leaves an unsourced figure alone: there is nothing to check it against", async () => {
    const report = await verifyCitedFigures(factCheckArticle("<p>Some 42% of clinics do this.</p>"), {
      fetcher: never,
    });
    expect(report.claims[0].status).toBe("unsourced");
  });

  it("reads each cited page once however many claims point at it", async () => {
    let calls = 0;
    const counting: PageFetcher = async () => {
      calls += 1;
      return { status: 200, body: BLS_PAGE };
    };
    const html =
      ARTICLE("5 percent") +
      `<p>According to the Bureau of Labor Statistics, median pay was $99,520 per year.` +
      ` <a href="${BLS_URL}">BLS</a></p>`;
    const report = await verifyCitedFigures(factCheckArticle(html), { fetcher: counting });
    expect(report.claims).toHaveLength(2);
    expect(calls).toBe(1);
  });
});

describe("figureVariants — the same number written differently", () => {
  it("matches a percentage across its spellings", () => {
    const page = readablePageText("<p>grew 8 percent last year</p>");
    expect(pageHasFigure(page, "8%")).toBe(true);
    expect(pageHasFigure(page, "8 percent")).toBe(true);
    expect(pageHasFigure(page, "9%")).toBe(false);
  });

  it("matches money with and without its separators", () => {
    const page = readablePageText("<p>a budget of 30000 dollars</p>");
    expect(pageHasFigure(page, "$30,000")).toBe(true);
  });

  it("matches a grouped figure against an ungrouped article", () => {
    const page = readablePageText("<p>we spent $1,250,000</p>");
    expect(pageHasFigure(page, "1250000")).toBe(true);
  });

  it("resolves entities and non-breaking spaces before looking", () => {
    expect(pageHasFigure(readablePageText("<p>5&nbsp;percent</p>"), "5 percent")).toBe(true);
  });

  it("keeps the original spelling among the variants", () => {
    expect(figureVariants("$540")).toContain("$540");
  });
});

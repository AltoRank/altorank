import { describe, it, expect } from "vitest";
import { factCheckArticle, approvalBlocker } from "@/lib/ai/fact-check";
import { verifyCitedFigures, pageHasFigure, type PageFetcher } from "@/lib/seo/citation-check";

/**
 * A diaper-cream draft (2026-10-22) gave a baby's hydrocortisone schedule in
 * words, citing a Mayo Clinic page that by then redirected to the symptoms
 * page and said none of it. Every claim pattern read digits, so the draft
 * "stated no figure" and the check came back `unchecked`.
 */
const MAYO_URL = "https://www.mayoclinic.org/diseases-conditions/diaper-rash/diagnosis-treatment/drc-20371636";
const SENTENCE =
  `according to <a href="${MAYO_URL}">Mayo Clinic</a>, a pediatrician may recommend a mild hydrocortisone ` +
  `cream used twice a day for three to five days`;
const ARTICLE = `<p>If the rash does not clear, ${SENTENCE}.</p>`;

const pad = `<p>${"Diaper rash is a common form of inflamed skin that appears as a patchwork of bright red skin on the bottom. ".repeat(6)}</p>`;
/** What the page says after the redirect: symptoms, no treatment. */
const SYMPTOMS_PAGE = `<html><body><h1>Diaper rash - Symptoms and causes</h1>${pad}</body></html>`;
/** A treatment page that gives the same schedule in digits. */
const TREATMENT_PAGE =
  `<html><body>${pad}<p>For severe rash, your doctor may recommend a mild (0.5 to 1 percent) hydrocortisone ` +
  `(steroid) cream twice a day for 3 to 5 days.</p></body></html>`;

const serve = (body: string): PageFetcher => async () => ({ status: 200, body });

describe("dosing written in words", () => {
  it("is a claim, not 'nothing to check'", () => {
    const report = factCheckArticle(ARTICLE);
    expect(report.verdict).toBe("review");
    expect(report.unchecked).toBeUndefined();
    const [claim] = report.claims;
    expect(claim.kind).toBe("dosing");
    expect(claim.figures).toEqual(["twice a day", "three to five days"]);
    expect(claim.attribution).toBe("Mayo Clinic");
    expect(claim.sourceUrl).toBe(MAYO_URL);
    expect(claim.note).toContain("hydrocortisone");
  });

  it("needs verification when the cited page lacks it", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE), { fetcher: serve(SYMPTOMS_PAGE) });
    const [claim] = report.claims;
    expect(claim.status).toBe("needs_verification");
    expect(claim.severity).toBe("medium");
    expect(claim.note).toContain('"hydrocortisone"');
    expect(claim.note).toContain('"three to five days"');
    expect(report.verdict).toBe("review");
  });

  it("is verified when the cited page has it in digits", async () => {
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE), { fetcher: serve(TREATMENT_PAGE) });
    expect(report.claims[0].status).toBe("verified");
    expect(report.verdict).toBe("clean");
  });

  it("is never clean on the figures alone: the page must name the medicine", async () => {
    const page = TREATMENT_PAGE.replace("hydrocortisone (steroid) ", "barrier ");
    const report = await verifyCitedFigures(factCheckArticle(ARTICLE), { fetcher: serve(page) });
    expect(report.claims[0].status).toBe("needs_verification");
    expect(report.verdict).toBe("review");
  });

  it("blocks approval when nothing sources it", () => {
    const report = factCheckArticle(
      "<p>A pediatrician may recommend a mild hydrocortisone cream used twice a day for three to five days.</p>",
    );
    expect(report.claims[0].status).toBe("unsourced");
    expect(report.verdict).toBe("high_risk");
    expect(approvalBlocker(report)).toContain("twice a day");
  });

  it("is read in digits too", () => {
    const report = factCheckArticle("<p>Give ibuprofen every 6 to 8 hours, no more than 4 doses a day.</p>");
    expect(report.claims[0].kind).toBe("dosing");
    expect(report.claims[0].figures).toEqual(["every 6 to 8 hours", "4 doses"]);
  });

  it("leaves a schedule that names no medicine alone", () => {
    expect(factCheckArticle("<p>Post twice a week for three to five months.</p>").claims).toEqual([]);
  });
});

describe("other figures written in words", () => {
  it("reads a worded percentage, multiplier and count", () => {
    const report = factCheckArticle(
      "<p>Twenty percent of buyers leave. It is three times faster. We serve two million users.</p>",
    );
    expect(report.claims.map((c) => [c.kind, c.figures])).toEqual([
      ["statistic", ["Twenty percent"]],
      ["multiplier", ["three times faster"]],
      ["large_count", ["two million users"]],
    ]);
  });

  it("matches either form on the page", () => {
    expect(pageHasFigure("grew 20% last year", "twenty percent")).toBe(true);
    expect(pageHasFigure("use it for three to five days", "3 to 5 days")).toBe(true);
    expect(pageHasFigure("use it for 3-5 days", "three to five days")).toBe(true);
    expect(pageHasFigure("apply two times daily", "twice a day")).toBe(true);
    expect(pageHasFigure("use it for 4 to 6 days", "three to five days")).toBe(false);
  });
});

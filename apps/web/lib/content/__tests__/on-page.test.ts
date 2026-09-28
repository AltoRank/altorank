import { describe, it, expect } from "vitest";
import { fitTitle, givenTitleKept, titleReviewNote, removeTitleHeading, faqPlan, faqReviewNote, hasFaqSection, TITLE_MAX } from "../on-page";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { scoreArticle } from "@/lib/seo/scoring";
import { auditArticle } from "@/lib/seo/article-audit";
import type { ArticleResearch } from "@/lib/seo/research";

// A real first article (2026-09-27, a physiotherapy clinic): a 77-character
// title, no FAQ section, and the title repeated as an <h1> at the top of the
// body, so the published page had two. Every title below is invented.

const KW = "physiotherapy vs athletic therapy";

describe("fitTitle: at most 60 characters, without a model", () => {
  it("keeps a title that fits", () => {
    const t = "Physiotherapy vs Athletic Therapy: Which Fits You?";
    expect(fitTitle(t, KW)).toEqual({ title: t, original: t, rule: "kept" });
  });

  it("keeps the clauses that fit and name the keyword, never a sentence cut mid-thought", () => {
    const long = "Physiotherapy vs Athletic Therapy: Which One Is Right for Your Sports Injury?";
    expect(long.length).toBeGreaterThan(TITLE_MAX);
    const fitted = fitTitle(long, KW);
    expect(fitted).toEqual({ title: "Physiotherapy vs Athletic Therapy", original: long, rule: "clause" });
    expect(titleReviewNote(fitted)).toMatch(/shortened from 77 to 33 characters/);
  });

  it("takes a later clause when that is the one with the keyword", () => {
    const long = "Not Sure Where to Start After an Injury? Physiotherapy vs Athletic Therapy Explained";
    const fitted = fitTitle(long, KW);
    expect(fitted.title).toBe("Physiotherapy vs Athletic Therapy Explained");
    expect(fitted.title.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it("drops a bracket at the end when nothing splits the title", () => {
    const fitted = fitTitle("Physiotherapy vs athletic therapy for weekend athletes (2026 Guide)", KW);
    expect(fitted).toMatchObject({ title: "Physiotherapy vs athletic therapy for weekend athletes", rule: "bracket" });
  });

  it("falls back to the keyword, capitalised, when no clause fits", () => {
    const fitted = fitTitle("Everything you need to know about physiotherapy vs athletic therapy before your next appointment", KW);
    expect(fitted).toMatchObject({ title: "Physiotherapy vs athletic therapy", rule: "keyword" });
  });

  it("cuts at a word only when the keyword itself is longer than 60", () => {
    const kw = "how to choose between physiotherapy and athletic therapy after an ankle sprain";
    const fitted = fitTitle(`${kw}: a guide`, kw);
    expect(fitted.rule).toBe("word");
    expect(fitted.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(fitted.title).not.toMatch(/\s$/);
  });

  it("reads the keyword with the article's language rules", () => {
    const fitted = fitTitle("Fizyoterapi ve atletik terapi arasındaki farklar: Sporcular için hangisi daha doğru bir seçim?", "fizyoterapi ve atletik terapi", "tr");
    expect(fitted.title).toBe("Fizyoterapi ve atletik terapi arasındaki farklar");
  });
});

describe("removeTitleHeading: the title is the page's H1, not the body's", () => {
  it("takes the title's <h1> out of a generated body and demotes any other", () => {
    const out = removeTitleHeading("<h1>Physio vs AT</h1><p>Intro.</p><h1>Stray</h1><h2>More</h2>");
    expect(out).toEqual({ html: "<p>Intro.</p><h2>Stray</h2><h2>More</h2>", removed: true, demoted: 1 });
  });

  it("at publish, removes a leading <h1> only when it says the title", () => {
    expect(removeTitleHeading("<h1>Physio vs AT</h1><p>x</p>", "physio VS at").html).toBe("<p>x</p>");
    expect(removeTitleHeading("<h1>A heading someone wrote</h1><p>x</p>", "Physio vs AT").html).toBe("<h2>A heading someone wrote</h2><p>x</p>");
  });

  it("scores and audits a body with no <h1> as having the title for its one H1", () => {
    const body = `<p>${KW} compared.</p><h2>What is ${KW}?</h2><p>x</p><h2>Costs</h2><p>y</p>`;
    const title = "Physiotherapy vs Athletic Therapy";
    const seo = scoreArticle(body, KW, { title, titleIsPageH1: true });
    expect(seo.checks.find((c) => c.name === "keywordInTitle")?.passed).toBe(true);
    expect(seo.checks.find((c) => c.name === "headingStructure")?.passed).toBe(true);
    const twice = scoreArticle(`<h1>${title}</h1>${body}`, KW, { title, titleIsPageH1: true });
    expect(twice.checks.find((c) => c.name === "headingStructure")?.note).toMatch(/title is already the page's H1/);

    const audit = auditArticle({ html: body, keyword: KW, title, titleIsPageH1: true });
    expect(audit.items.find((i) => i.id === "single-h1")?.status).toBe("pass");
    const auditTwice = auditArticle({ html: `<h1>${title}</h1>${body}`, keyword: KW, title, titleIsPageH1: true });
    expect(auditTwice.items.find((i) => i.id === "single-h1")?.status).toBe("fail");
    // A crawled page is still judged as a whole page.
    expect(auditArticle({ html: body, keyword: KW, title }).items.find((i) => i.id === "single-h1")?.status).toBe("fail");
  });

  it("tells the writer its <h1> becomes the title and no other may exist", () => {
    const p = buildSystemPrompt({ keyword: KW });
    expect(p).toContain("published as the page's title");
    expect(p).toContain("never use <h1>");
  });
});

const research = (peopleAlsoAsk: string[]): ArticleResearch => ({
  keyword: KW,
  language: "English",
  intent: { intent: "info", confidence: "high", signals: [], lexicon: true },
  competitors: [],
  peopleAlsoAsk,
  aiOverview: null,
  relatedKeywords: [],
  existingPerformance: null,
  adjacentQueries: [],
  recommendedWordCount: 1500,
  wordCountBasis: "test",
  layers: [],
});

describe("faqPlan: a FAQ section where the results page shows people ask", () => {
  const Q = ["Is athletic therapy covered by insurance?", "Can an athletic therapist diagnose?", "Which is better for a sprain?"];

  it("asks for one when two or more questions are asked, for a guide", () => {
    expect(faqPlan({ articleType: "guide", questions: Q })).toMatchObject({ include: true, questions: 3 });
    const p = buildSystemPrompt({ keyword: KW, research: research(Q), brief: { answers: [], articleType: "guide", articleSubtype: "comparison" } });
    expect(p).toContain("End the article with <h2>Frequently asked questions</h2>: the search results show 3 questions");
  });

  it("asks for one with no output-settings row at all, which is where the old request lived", () => {
    expect(buildSystemPrompt({ keyword: KW, research: research(Q) })).toContain("End the article with <h2>Frequently asked questions</h2>");
  });

  it("says no, and why, for a list article or a results page without questions", () => {
    expect(faqPlan({ articleType: "listicle", questions: Q }).include).toBe(false);
    expect(faqPlan({ articleType: "guide", questions: [Q[0]] }).include).toBe(false);
    expect(buildSystemPrompt({ keyword: KW, research: research([]) })).toContain(
      "Do not add a FAQ section: the search results show no questions people ask for this search.",
    );
  });

  it("leaves a rewrite's FAQ to its brief", () => {
    const p = buildSystemPrompt({ keyword: KW, research: research(Q), refreshOf: { existingHtml: "<p>x</p>", brief: "b" } });
    expect(p).not.toContain("End the article with <h2>");
    expect(p).not.toContain("Do not add a FAQ section");
  });

  it("notes a draft that was asked for a FAQ and has none", () => {
    const plan = faqPlan({ articleType: "guide", questions: Q });
    expect(faqReviewNote(plan, "<h2>Costs</h2><p>x</p>")).toMatch(/No FAQ section, although the search results show 3 questions/);
    expect(faqReviewNote(plan, "<h2>Frequently asked questions</h2><h3>Q?</h3><p>A.</p>")).toBeNull();
    expect(hasFaqSection("<h2>Sıkça sorulan sorular</h2>")).toBe(true);
  });
});

describe("review round 2026-09-28: fitTitle keeps the subject", () => {
  it("prefers the first clause, where the subject is, over a later follow-up", () => {
    expect(fitTitle("Physiotherapy vs Athletic Therapy: Which One Fits Your Injury and Budget?", "sports injury rehab", "en").title).toBe(
      "Physiotherapy vs Athletic Therapy",
    );
    expect(fitTitle("Physiotherapie oder Osteopathie – was hilft bei Rückenschmerzen wirklich am besten?", "physiotherapie rückenschmerzen", "de").title).toBe(
      "Physiotherapie oder Osteopathie",
    );
    expect(fitTitle("Kinésithérapie ou ostéopathie : laquelle choisir pour soulager votre mal de dos ?", "kinésithérapie mal de dos", "fr").title).toBe(
      "Kinésithérapie ou ostéopathie",
    );
  });

  it("never returns more than 60 characters, even from a keyword with no space to cut at", () => {
    const long = "a".repeat(80);
    expect(fitTitle(long, long, "en").title.length).toBeLessThanOrEqual(60);
  });

  it("keeps a title the caller gave as given, and says when it is long", () => {
    const given = "Physiotherapy vs Athletic Therapy: Which One Fits Your Injury and Budget?";
    const kept = givenTitleKept(given, given);
    expect(kept).toMatchObject({ title: given, rule: "given" });
    expect(titleReviewNote(kept!)).toMatch(/kept as given/);
    expect(givenTitleKept(given, "A different title the writer chose")).toBeNull();
    expect(givenTitleKept(null, given)).toBeNull();
  });
});

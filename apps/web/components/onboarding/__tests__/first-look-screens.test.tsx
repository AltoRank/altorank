import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The first look's two screens, as markup: what the loading screen says each
// phase found, and what the gate's article card claims while the body is
// still being written. renderToStaticMarkup, as the other panels are tested:
// no jsdom in this repo.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

import { pagesLine, phaseDetail } from "../setup-loading";
import { FirstArticleCardView, stageLine, verdictLine, wordsLine, writtenFor } from "../first-article-card";
import { articleHeading, welcomeLine } from "../first-look-gate";
import { plainTopicLabel, topicLabels } from "@/lib/keyword-research/topic-labels";
import type { FirstArticleCard } from "@/lib/onboarding/first-article";
import type { FirstArticleLive } from "../use-first-article-live";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

const OUTLINED: FirstArticleCard = {
  id: "a1",
  title: "Acme kits: how to choose one",
  keyword: "a rather long target search that used to be cut off in the meta row",
  scheduledDate: "2026-10-12",
  outline: ["Key takeaways", "What is in a kit?", "How to choose one", "Learn more about Acme"],
  wordCount: 1700,
  sources: 0,
  verdict: null,
  more: 0,
  labels: [],
  state: "outlined",
};

const live = (over: Partial<FirstArticleLive> = {}): FirstArticleLive => ({
  html: "", done: false, stage: "writing", stageSince: null, sectionsDone: [0], words: 240, arrivalCps: 0, refused: false, ...over,
});

describe("the loading screen's lines", () => {
  const base = { keywordsFound: 81, planned: [] };
  it("says what each phase found, in a person's words", () => {
    expect(phaseDetail({ phase: "keywords", status: "done", detail: "81 keywords found: 169/169 buyer decisions confirmed" }, base, null, 0)).toBe("81 searches your buyers make");
    expect(phaseDetail({ phase: "pages", status: "done", detail: "Read 40 pages. Found 49 technical issues on 25 of them. Stopped at 40 of 125; the nightly pass reads the rest." }, base, null, 0))
      .toBe("40 pages read, 25 with something to fix");
    expect(phaseDetail({ phase: "scanning", status: "pending" }, base, null, 0)).toBe("");
  });

  it("names the searches being checked, one at a time, and the counts", () => {
    const step = { phase: "planning" as const, status: "active" as const, checking: { terms: ["acme kits", "acme kit price"], judged: 15, qualified: 2 } };
    expect(phaseDetail(step, base, null, 0)).toBe("Checking the results for “acme kits” · 15 checked");
    expect(phaseDetail(step, base, null, 1)).toBe("Checking the results for “acme kit price” · 15 checked");
    expect(phaseDetail({ ...step, checking: { terms: [], judged: 30, qualified: 3 } }, base, null, 0)).toBe("30 searches checked, 3 cleared the bar");
  });

  it("holds on the counts, naming no term, when less motion is asked for", () => {
    const step = { phase: "planning" as const, status: "active" as const, checking: { terms: ["acme kits", "acme kit price"], judged: 15, qualified: 2 } };
    expect(phaseDetail(step, base, null, null)).toBe("15 searches checked, 2 cleared the bar");
    expect(phaseDetail({ ...step, checking: { ...step.checking, judged: 0 } }, base, null, null)).not.toContain("acme");
  });

  it("words the pages line one way, from one source, whether or not the report has landed", () => {
    const detail = "Read 40 pages. Found 49 technical issues on 25 of them.";
    const report = { existingPages: { checked: 39, withIssues: 25 } } as unknown as Parameters<typeof phaseDetail>[2];
    expect(phaseDetail({ phase: "pages", status: "done", detail }, base, report, 0)).toBe("40 pages read, 25 with something to fix");
    expect(pagesLine("Read 1 page. Nothing technical to fix.")).toBe("1 page read, nothing to fix");
    expect(pagesLine("Could not read the site.")).toBeNull();
  });

  it("does not say the outline is being written", () => {
    expect(phaseDetail({ phase: "drafting", status: "active", detail: "Read 8 ranking pages and 2 questions people ask. Outlining it now." }, base, null, 0))
      .toBe("Read 8 ranking pages and 2 questions people ask.");
  });
});

describe("the gate's article card", () => {
  it("never says written while the body is owed, prints no zero sources and shows the whole search", () => {
    const html = text(renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live()} />));
    expect(html).toContain("Being written");
    expect(html).not.toMatch(/\bWritten\b/);
    expect(html).not.toContain("Sources");
    expect(html).toContain(OUTLINED.keyword);
    // One word figure: the target until the writer's count is in, then that count.
    expect(html).toContain("Length 240 words so far");
    expect(html).not.toContain("About 1,700 words");
    expect(text(renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live({ words: 0 })} />))).toContain("Length About 1,700 words");
    expect(html).toContain("Writing section 2 of 4 · 240 words so far");
    // No fact-check verdict on the paywall.
    expect(html).not.toContain("Fact check");
  });

  it("ticks the outline from the counts, and carries no text with the switch off", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live({ sectionsDone: [0, 1], html: "<p>never shown</p>" })} />);
    expect(text(markup)).toContain("Key takeaways (written)");
    expect(text(markup)).toContain("How to choose one (being written)");
    expect(markup).not.toContain("never shown");
  });

  it("says written, with the real count, once the body is saved", () => {
    const written: FirstArticleCard = { ...OUTLINED, state: "written", wordCount: 1381, sources: 4 };
    const html = text(renderToStaticMarkup(<FirstArticleCardView article={written} live={live({ done: true })} />));
    expect(html).toContain("Draft ready");
    expect(html).not.toMatch(/\bWritten\b(?! for)/);
    expect(html).toContain("1,381 words");
    expect(html).toContain("Sources cited 4");
    expect(html).not.toContain("About 1,700");
  });

  it("hides a source count below three: one or two read as thin research", () => {
    const written: FirstArticleCard = { ...OUTLINED, state: "written", wordCount: 1381, sources: 2 };
    expect(text(renderToStaticMarkup(<FirstArticleCardView article={written} live={live({ done: true })} />))).not.toContain("Sources");
    expect(text(renderToStaticMarkup(<FirstArticleCardView article={{ ...written, sources: 3 }} live={live({ done: true })} />))).toContain("Sources cited 3");
  });

  it("promises no date and no readiness before the trial", () => {
    const html = text(renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live()} />));
    expect(html).not.toMatch(/Scheduled for|Oct 12|Ready when you approve it|Publishing/);
  });

  it("says what the fact check left to do, under a badge that is not green", () => {
    const written = (verdict: FirstArticleCard["verdict"]): string =>
      renderToStaticMarkup(<FirstArticleCardView article={{ ...OUTLINED, state: "written", wordCount: 1381, verdict }} live={live({ done: true })} />);
    expect(text(written("high_risk"))).toContain("Some claims need checking before you publish");
    expect(text(written("review"))).toContain("Some claims need checking before you publish");
    expect(text(written("unchecked"))).toContain("Facts have not been checked");
    expect(text(written(null))).toContain("Facts have not been checked");
    expect(text(written("clean"))).not.toMatch(/claims need checking|not been checked/);
    const clean = written("clean");
    expect(clean.slice(clean.lastIndexOf("<span", clean.indexOf("Draft ready")), clean.indexOf("Draft ready"))).not.toContain("bg-ok-soft");
    // An outline has no check yet, and says nothing about one.
    expect(verdictLine("clean")).toBeNull();
    expect(text(renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live()} />))).not.toMatch(/checked|checking before/);
  });

  it("folds who it is for, the search, the length and the sources into Article details", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live()} brief={{ audience: "Home decorators" } as never} />);
    const fold = markup.slice(markup.indexOf("<details"), markup.indexOf("</details>"));
    expect(text(fold)).toContain("Article details");
    for (const fact of ["Written for", "Target search", "Length"]) expect(text(fold)).toContain(fact);
  });

  it("shows no verdict labels on the paywall: no funnel stage, no warning-orange confidence", () => {
    const labelled: FirstArticleCard = { ...OUTLINED, labels: topicLabels({ funnel: "audience", confidence: "lower", demand: "unmeasured" }) };
    const markup = renderToStaticMarkup(<FirstArticleCardView article={labelled} live={live()} />);
    expect(text(markup)).not.toMatch(/Early reader|not yet shopping|Top of funnel|Lower confidence|Unmeasured/);
    expect(markup).not.toContain("text-warn");
  });

  it("leaves the site's own closing out of the outline it lists, but counts it for the writer", () => {
    const withClosing: FirstArticleCard = { ...OUTLINED, closing: "Learn more about Acme" };
    const markup = renderToStaticMarkup(<FirstArticleCardView article={withClosing} live={live({ sectionsDone: [0, 1, 2] })} />);
    expect(text(markup)).not.toContain("Learn more about Acme");
    expect(text(markup)).toContain("How to choose one (written)");
    expect(text(markup)).toContain("Writing section 4 of 4");
  });

  it("replaces the outline with the text when the owner may read it", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} readable live={live({ html: "<h2>Key takeaways</h2><p>Kits vary.</p>" })} />);
    // The text is revealed by the browser, frame by frame; on the server it
    // starts empty, and the outline card is not drawn beside it.
    expect(markup).not.toContain(">Outline<");
    // The gate's lede says the trial is for editing it; the card does not say it again.
    expect(text(markup)).not.toContain("Read-only.");
    expect(text(markup)).not.toMatch(/trial/i);
  });

  it("says who it is for without gluing the buying job on as a broken sentence", () => {
    expect(writtenFor({ audience: "Home decorators looking for ideas." })).toBe("Home decorators looking for ideas");
    expect(writtenFor({ audience: "  " })).toBeNull();
    const html = text(renderToStaticMarkup(
      <FirstArticleCardView article={OUTLINED} live={live()} brief={{ audience: "Home decorators looking for ideas", buyingJob: "Source kits and ideas" } as never} />,
    ));
    expect(html).toContain("Written for Home decorators looking for ideas");
    expect(html).not.toContain("Source kits");
  });

  it("puts only the stage in the live region; the word count beside it is not re-read", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} live={live()} />);
    expect(markup).toContain('<span role="status">Writing section 2 of 4</span>');
    expect(markup).not.toContain("aria-live");
    expect(stageLine("finishing", 3, 4)).toBe("Checking its facts and adding links");
    expect(wordsLine("writing", 0)).toBe("");
    expect(wordsLine("finishing", 1200)).toBe("1,200 words");
  });

  it("words the funnel label for a first-timer", () => {
    const [label] = topicLabels({ funnel: "audience" }).map(plainTopicLabel);
    expect(label.label).toBe("Early reader");
    expect(label.explain).not.toMatch(/funnel|providers/i);
  });

  it("opens a return with what happened: back, or a checkout that charged nothing", () => {
    expect(welcomeLine("returning")).toBe("Welcome back. Your article is saved.");
    expect(welcomeLine("cancelled")).toBe("Your trial hasn't started. Nothing was charged.");
  });

  it("words the heading by how far the article has got", () => {
    expect(articleHeading(false, false).heading).toBe("Your first article is being written");
    expect(articleHeading(true, true).heading).toBe("Your first article is written");
    expect(articleHeading(false, true).lede).toContain("Read it below as it is written");
  });

  it("promises more articles only as many as the plan holds, and never 'the rest of the week'", () => {
    for (const [written, full] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      expect(articleHeading(written, full, 0).lede).not.toMatch(/rest of the week|more topic|30-day|month/i);
    }
    expect(articleHeading(true, true, 3).lede).toContain("the 3 more topics we found for your site");
    expect(articleHeading(true, false, 1).lede).toContain("The 1 more topic we found for your site");
  });
});

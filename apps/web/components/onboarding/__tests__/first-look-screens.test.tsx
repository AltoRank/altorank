import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The first look's two screens, as markup: what the loading screen says each
// phase found, and what the gate's article card claims while the body is
// still being written. renderToStaticMarkup, as the other panels are tested:
// no jsdom in this repo.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

import { pagesLine, phaseDetail } from "../setup-loading";
import { FirstArticleCardView, stageLine, wordsLine, writtenFor } from "../first-article-card";
import { articleHeading, stickyLine } from "../first-look-gate";
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
    expect(html).toContain("About 1,700 words");
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
    const written: FirstArticleCard = { ...OUTLINED, state: "written", wordCount: 1381, sources: 2 };
    const html = text(renderToStaticMarkup(<FirstArticleCardView article={written} live={live({ done: true })} />));
    expect(html).toContain("Written");
    expect(html).toContain("1,381 words");
    expect(html).toContain("Sources cited 2");
    expect(html).not.toContain("About 1,700");
  });

  it("replaces the outline with the text when the owner may read it", () => {
    const markup = renderToStaticMarkup(<FirstArticleCardView article={OUTLINED} readable live={live({ html: "<h2>Key takeaways</h2><p>Kits vary.</p>" })} />);
    // The text is revealed by the browser, frame by frame; on the server it
    // starts empty, and the outline card is not drawn beside it.
    expect(markup).not.toContain(">Outline<");
    expect(text(markup)).toContain("Read-only.");
  });

  it("says who it is for without gluing the buying job on as a broken sentence", () => {
    expect(writtenFor({ audience: "Home decorators looking for ideas." })).toBe("Home decorators looking for ideas");
    expect(writtenFor({ audience: "  " })).toBeNull();
    const html = text(renderToStaticMarkup(
      <FirstArticleCardView article={OUTLINED} live={live()} brief={{ audience: "Home decorators looking for ideas", buyingJob: "Source kits and ideas" } as never} />,
    ));
    expect(html).toContain("Written for: Home decorators looking for ideas");
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

  it("the slim trial bar never offers to let them read what they are reading", () => {
    expect(stickyLine(false, true)).toBe("Edit, approve and publish it with the trial.");
    expect(stickyLine(true, true)).not.toMatch(/read it/i);
    expect(stickyLine(false, false)).toBe("Read it in full once it is written.");
  });

  it("words the heading by how far the article has got", () => {
    expect(articleHeading(false, false).heading).toBe("Your first article is being written");
    expect(articleHeading(true, true).heading).toBe("Your first article is written");
    expect(articleHeading(false, true).lede).toContain("Read it below as it is written");
  });
});

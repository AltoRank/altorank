import { describe, expect, it } from "vitest";
import { topicLabels } from "../topic-labels";
import { toFirstArticleCard } from "@/lib/onboarding/first-article";

describe("the labels a planned topic carries to the screen", () => {
  it("says lower confidence and unmeasured, and nothing for a topic that cleared the bar on measured demand", () => {
    expect(topicLabels({ status: "qualified", confidence: "lower", demand: "unmeasured" }).map((l) => l.label)).toEqual(["Lower confidence", "Unmeasured"]);
    expect(topicLabels({ status: "qualified" })).toEqual([]);
    expect(topicLabels(null)).toEqual([]);
  });
  it("says top of funnel for a reader who is not shopping yet", () => {
    expect(topicLabels({ status: "qualified", funnel: "audience" }).map((l) => l.label)).toEqual(["Top of funnel"]);
    expect(topicLabels({ status: "qualified", funnel: "buyer" })).toEqual([]);
  });
  it("drops 'unmeasured' once the row has a volume of its own", () => {
    const verdict = { status: "qualified", demand: "unmeasured" };
    expect(topicLabels(verdict, { volume: null }).map((l) => l.label)).toEqual(["Unmeasured"]);
    expect(topicLabels(verdict, { volume: 70 })).toEqual([]);
    expect(topicLabels(verdict, { volume: 0 })).toEqual([]);
  });
  it("puts them on the first article's card, from the verdict it was planned on", () => {
    const card = toFirstArticleCard(
      { id: "a", title: "T", keyword: "k", word_count: 900, fact_check_verdict: "clean", content: "<h2>One</h2>" },
      { domain: "site.test", scheduledDate: null, more: 0, verdict: { status: "qualified", confidence: "lower" } },
    );
    expect(card.labels.map((l) => l.label)).toEqual(["Lower confidence"]);
    expect(card.labels[0].explain).toContain("fewer than three topics cleared the bar");
  });
});

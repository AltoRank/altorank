import { describe, expect, it } from "vitest";
import { foundOnSiteView, isFoundOnSite, LIVE_ON_YOUR_SITE, liveLabel, tallyArticles } from "../state";

const url = "https://acme-agency.example/blog/kopya";
const found = {
  status: "live",
  published_url: url,
  found_on_site_at: "2026-09-23T10:00:00.000Z",
  found_on_site_evidence: { containment: 0.656, title: 0.57, rule: "text" },
};

describe("found-on-site state", () => {
  it("is a distinct state from live-because-we-published-it", () => {
    expect(isFoundOnSite(found)).toBe(true);
    expect(liveLabel(found)).toBe(LIVE_ON_YOUR_SITE);

    const pushed = { status: "live", published_url: url, found_on_site_at: null };
    expect(isFoundOnSite(pushed)).toBe(false);
    // Undefined, so the pill keeps its own "Live".
    expect(liveLabel(pushed)).toBeUndefined();
    expect(foundOnSiteView(pushed)).toBeNull();
  });

  it("is not a find once the article is no longer live", () => {
    expect(isFoundOnSite({ ...found, status: "review" })).toBe(false);
    expect(liveLabel({ ...found, status: "review" })).toBeUndefined();
  });

  it("says what the match rests on, in what was measured", () => {
    expect(foundOnSiteView(found)).toEqual({
      url,
      foundAt: "2026-09-23T10:00:00.000Z",
      textPercent: 66,
      basis: "66% of the draft's text appears on that page word for word",
    });
    expect(foundOnSiteView({ ...found, found_on_site_evidence: { containment: 0.41, rule: "text+title" } })?.basis).toBe(
      "41% of the draft's text appears on that page word for word, under the same headline",
    );
  });

  it("does not claim a number it does not have", () => {
    const v = foundOnSiteView({ ...found, found_on_site_evidence: null });
    expect(v?.textPercent).toBeNull();
    expect(v?.basis).toMatch(/was not recorded/);
  });
});

describe("tallyArticles", () => {
  it("counts a found article as live, and says how many were found", () => {
    const t = tallyArticles([
      { workspace_id: "w1", status: "review" },
      { workspace_id: "w1", status: "live", found_on_site_at: null },
      { workspace_id: "w1", status: "live", found_on_site_at: "2026-09-23T10:00:00Z" },
      { workspace_id: "w2", status: "review", found_on_site_at: "2026-09-23T10:00:00Z" },
    ]);
    expect(t.get("w1")).toEqual({ total: 3, live: 2, foundOnSite: 1 });
    // Undone finds keep nothing: only a live article counts.
    expect(t.get("w2")).toEqual({ total: 1, live: 0, foundOnSite: 0 });
  });
});

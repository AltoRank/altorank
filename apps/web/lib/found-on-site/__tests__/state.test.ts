import { describe, expect, it } from "vitest";
import { BLIND_REASON, blindNote, foundOnSiteView, isFoundOnSite, LIVE_ON_YOUR_SITE, liveLabel, tallyArticles } from "../state";

const url = "https://acme-agency.example/blog/kopya";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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
      when: `Our nightly check found it there on ${day("2026-09-23T10:00:00.000Z")}. Your sitemap gave no date we could use, so it may have gone live earlier.`,
      origin: "It went live without going through AltoRank, and counts as published.",
    });
    expect(foundOnSiteView({ ...found, found_on_site_evidence: { containment: 0.41, rule: "text+title" } })?.basis).toBe(
      "41% of the draft's text appears on that page word for word, under the same headline",
    );
  });

  it("dates it by the sitemap only when the check trusted that date, and never calls the night of the find the publish date", () => {
    const dated = foundOnSiteView({
      ...found,
      published_at: "2026-09-22T10:48:00.000Z",
      found_on_site_evidence: { containment: 0.66, rule: "text", lastmodTrusted: true },
    })!;
    expect(dated.when).toBe(
      `Your sitemap dates it ${day("2026-09-22T10:48:00.000Z")}; our nightly check found it there on ${day("2026-09-23T10:00:00.000Z")}.`,
    );
    // published_at is the find time when the lastmod was not usable.
    const undated = foundOnSiteView({
      ...found,
      published_at: "2026-09-23T10:00:00.000Z",
      found_on_site_evidence: { containment: 0.66, rule: "text", lastmodTrusted: false },
    })!;
    expect(undated.when).toMatch(/^Our nightly check found it there on .*may have gone live earlier\.$/);
  });

  it("does not say it went past AltoRank when we had pushed it ourselves", () => {
    const ours = foundOnSiteView({ ...found, found_on_site_evidence: { containment: 0.9, rule: "text", pushedEarlier: true } })!;
    expect(ours.origin).toBe("We sent it to your site earlier but could not confirm its address then; it now counts as published.");
    expect(ours.origin).not.toMatch(/without going through AltoRank/);
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

describe("blindNote", () => {
  const ws = { domain: "acme-agency.example", found_on_site_checked_at: "2026-09-23T10:00:00.000Z" };

  it("says nothing for a site the check can see, or has not looked at", () => {
    expect(blindNote({ ...ws, found_on_site_unreadable: null }, "review")).toBeNull();
    expect(blindNote({ domain: "acme-agency.example" }, "review")).toBeNull();
  });

  it("names the site, the reason, and how to make a hand-published copy count", () => {
    const approved = blindNote({ ...ws, found_on_site_unreadable: "no-sitemap" }, "approved")!;
    expect(approved).toContain("We can't see new pages on acme-agency.example");
    expect(approved).toContain(BLIND_REASON["no-sitemap"]);
    expect(approved).toContain("paste its address below once it is live");
    const review = blindNote({ ...ws, found_on_site_unreadable: "javascript" }, "review")!;
    expect(review).toContain("JavaScript");
    expect(review).toContain("once it is approved, paste its address here");
  });

  it("has a sentence for every reason the check stores", () => {
    for (const code of ["robots-unanswered", "robots-disallowed", "no-sitemap", "empty-sitemap", "javascript"] as const) {
      expect(BLIND_REASON[code]).toBeTruthy();
    }
    // A code from a newer build still says the site cannot be seen.
    expect(blindNote({ ...ws, found_on_site_unreadable: "something-new" }, "review")).toContain("could not read it");
  });
});

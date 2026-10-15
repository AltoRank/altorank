import { describe, it, expect } from "vitest";
import { fakeStorage } from "./fake-storage";
import {
  articleOfImage,
  neverLiveArticleIds,
  purgeArticleImages,
  purgeWorkspaceReports,
  wasEverLive,
} from "../purge";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LIVE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function images() {
  return [
    `${WS}/${DRAFT}.webp`,
    `${WS}/${DRAFT}-1.webp`,
    `${WS}/${DRAFT}-2.png`,
    `${WS}/${DRAFT}/proposals/1760000000000.png`,
    `${WS}/${DRAFT}/proposals/1760000000001.jpeg`,
    `${WS}/${LIVE}.webp`,
    `${WS}/${LIVE}-1.webp`,
    `${WS}/${LIVE}/proposals/1760000000002.png`,
    `${WS}/${OTHER}.webp`,
    `${OTHER_WS}/${DRAFT}.webp`,
  ];
}

describe("wasEverLive", () => {
  it("is true for anything that reached a reader or a CMS", () => {
    expect(wasEverLive({ status: "live" })).toBe(true);
    expect(wasEverLive({ status: "review", published_url: "https://acme.co/a" })).toBe(true);
    expect(wasEverLive({ status: "approved", published_at: "2026-10-01" })).toBe(true);
    expect(wasEverLive({ status: "review", external_id: "wp-12" })).toBe(true);
    expect(wasEverLive({ status: "review", found_on_site_at: "2026-10-01" })).toBe(true);
  });
  it("is false for a draft that never left", () => {
    expect(wasEverLive({ status: "review" })).toBe(false);
    expect(wasEverLive({ status: "error", published_url: null, external_id: null })).toBe(false);
  });
});

describe("articleOfImage", () => {
  it("reads the article from every layout the writers use", () => {
    expect(articleOfImage(`${DRAFT}.webp`)).toBe(DRAFT);
    expect(articleOfImage(`${DRAFT}-3.png`)).toBe(DRAFT);
    expect(articleOfImage(DRAFT)).toBe(DRAFT);
    expect(articleOfImage(DRAFT.toUpperCase())).toBe(DRAFT);
  });
  it("ignores names that are not an article's", () => {
    expect(articleOfImage("logo.png")).toBeNull();
    expect(articleOfImage(`${DRAFT}x.webp`)).toBeNull();
  });
});

describe("purgeArticleImages", () => {
  it("removes one draft's images and proposals, and nothing else", async () => {
    const fake = fakeStorage({ "article-images": images() });
    const n = await purgeArticleImages(fake.client, WS, [DRAFT]);
    expect(n).toBe(5);
    expect(fake.paths("article-images")).toEqual(
      [
        `${WS}/${LIVE}.webp`,
        `${WS}/${LIVE}-1.webp`,
        `${WS}/${LIVE}/proposals/1760000000002.png`,
        `${WS}/${OTHER}.webp`,
        `${OTHER_WS}/${DRAFT}.webp`,
      ].sort(),
    );
  });

  it("removes several articles at once", async () => {
    const fake = fakeStorage({ "article-images": images() });
    await purgeArticleImages(fake.client, WS, [DRAFT, OTHER]);
    expect(fake.has("article-images", `${WS}/${OTHER}.webp`)).toBe(false);
    expect(fake.has("article-images", `${WS}/${LIVE}.webp`)).toBe(true);
  });

  it("does nothing for no articles", async () => {
    const fake = fakeStorage({ "article-images": images() });
    expect(await purgeArticleImages(fake.client, WS, [])).toBe(0);
    expect(fake.removed).toHaveLength(0);
  });

  it("pages through a folder larger than one listing", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => `${WS}/${DRAFT}-${i}.webp`);
    const fake = fakeStorage({ "article-images": [...many, `${WS}/${LIVE}.webp`] });
    expect(await purgeArticleImages(fake.client, WS, [DRAFT])).toBe(1500);
    expect(fake.paths("article-images")).toEqual([`${WS}/${LIVE}.webp`]);
  });
});

describe("purgeWorkspaceReports", () => {
  it("removes the site's report PDFs and no other site's", async () => {
    const fake = fakeStorage({
      reports: [
        `reports/${WS}/2026-08-01_2026-08-31.pdf`,
        `reports/${WS}/2026-09-01_2026-09-30.pdf`,
        `reports/${OTHER_WS}/2026-09-01_2026-09-30.pdf`,
      ],
    });
    expect(await purgeWorkspaceReports(fake.client, WS)).toBe(2);
    expect(fake.paths("reports")).toEqual([`reports/${OTHER_WS}/2026-09-01_2026-09-30.pdf`]);
  });
});

describe("neverLiveArticleIds", () => {
  it("lists the site's drafts that never reached a reader", async () => {
    const fake = fakeStorage({}, [
      { id: DRAFT, workspace_id: WS, status: "review" },
      { id: LIVE, workspace_id: WS, status: "live", published_url: "https://acme.co/x" },
      { id: OTHER, workspace_id: WS, status: "approved", external_id: "wp-1" },
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", workspace_id: OTHER_WS, status: "review" },
    ]);
    expect(await neverLiveArticleIds(fake.client, WS)).toEqual([DRAFT]);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/app/actions/articles", () => ({ updateArticle: async () => {}, deleteArticle: async () => {} }));
vi.mock("@/app/actions/publish", () => ({
  publishArticle: async () => ({}),
  retryPublish: async () => ({}),
  holdArticle: async () => {},
  releaseHold: async () => {},
}));

import { publishOutcome } from "../article-row-menu";

describe("publishOutcome", () => {
  /** A draft-mode connection leaves the article Approved, not Live. */
  it("does not say Published when the CMS only saved a draft", () => {
    expect(publishOutcome({ publishMode: "draft" })).toContain("Saved as a draft on the CMS");
    expect(publishOutcome({ publishMode: "draft" })).not.toBe("Published");
  });

  it("treats a CMS that held the post itself as a draft too", () => {
    expect(publishOutcome({ publishMode: "publish", status: "draft" })).toContain("Saved as a draft");
  });

  it("says Published when it went live", () => {
    expect(publishOutcome({ publishMode: "publish", status: "publish" })).toBe("Published");
    expect(publishOutcome({ publishMode: "publish" }, true)).toBe("Published this time");
    expect(publishOutcome({ publishMode: "draft" }, true)).toBe("Saved as a draft this time");
  });
});

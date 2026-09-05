import { describe, expect, it } from "vitest";
import { articleMutations, keywordMutations } from "../mutations";
import type { ArticleStatus, KeywordStatus } from "@/lib/types";

const ALL_ARTICLE: ArticleStatus[] = ["draft", "drafting", "review", "approved", "scheduled", "live", "error", "archived"];

describe("articleMutations", () => {
  it("never allows approve, publish or delete, whatever the status", () => {
    for (const status of ALL_ARTICLE) {
      const m = articleMutations({ status });
      expect(m.approve.allowed).toBe(false);
      expect(m.publish.allowed).toBe(false);
      expect(m.delete.allowed).toBe(false);
      expect(m.approve.reason).toMatch(/human/i);
    }
  });

  it("allows regenerating an unreviewed draft, a rejected one, or a failed run", () => {
    for (const status of ["draft", "review", "error"] as ArticleStatus[]) {
      expect(articleMutations({ status }).regenerate).toEqual({ allowed: true });
    }
  });

  it("refuses to regenerate a published article and says to refresh instead", () => {
    const m = articleMutations({ status: "live" });
    expect(m.regenerate.allowed).toBe(false);
    expect(m.regenerate.reason).toBe("This article is published; create a refresh instead.");
  });

  it("refuses while a run is in progress, or once a human approved or scheduled it", () => {
    for (const status of ["drafting", "approved", "scheduled", "archived"] as ArticleStatus[]) {
      const m = articleMutations({ status });
      expect(m.regenerate.allowed).toBe(false);
      expect(m.regenerate.reason).toBeTruthy();
    }
  });

  it("explains refresh: only live articles qualify, and not through this surface yet", () => {
    expect(articleMutations({ status: "live" }).refresh.reason).toMatch(/not available/i);
    expect(articleMutations({ status: "draft" }).refresh.reason).toMatch(/published/i);
  });
});

describe("keywordMutations", () => {
  it("lets an agent draft for new, planned or errored keywords", () => {
    for (const status of ["new", "planned", "error"] as KeywordStatus[]) {
      expect(keywordMutations({ status }).generate_draft).toEqual({ allowed: true });
    }
  });

  it("stops a second draft for a keyword already being written, scheduled or live", () => {
    for (const status of ["drafting", "scheduled", "shipped"] as KeywordStatus[]) {
      const m = keywordMutations({ status });
      expect(m.generate_draft.allowed).toBe(false);
      expect(m.generate_draft.reason).toBeTruthy();
    }
  });
});

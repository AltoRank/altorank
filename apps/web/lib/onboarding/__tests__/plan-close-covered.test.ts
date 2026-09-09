import { describe, it, expect } from "vitest";
import { closeCoveredEntries } from "../plan";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A calendar entry the live queue already wrote.
 *
 * `duePlannedKeyword` only skips entries carrying an `article_id`, and only the
 * planned path ever sets one. When `pickNextKeyword` writes a term that also
 * sits in the calendar, that entry stays open and the plan comes back for the
 * same keyword on its scheduled day. qasimcode.com had two queued on
 * 2026-09-09, each for a keyword it had already published.
 */

type Entry = { id: string; keyword_id: string | null; keyword: string | null };
type Article = { id: string; keyword_id: string | null; keyword: string | null };

/** Records the updates so a test can assert what was closed, and to what. */
function client(entries: Entry[], articles: Article[]) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const keywordUpdates: string[] = [];

  const from = (table: string): Record<string, unknown> => {
    if (table === "keywords") {
      const self: Record<string, unknown> = {};
      self.update = () => self;
      self.eq = (_c: string, id: string) => {
        keywordUpdates.push(id);
        return Promise.resolve({ data: null, error: null });
      };
      return self;
    }
    if (table === "articles") {
      const self: Record<string, unknown> = {};
      self.select = () => self;
      self.eq = () => Promise.resolve({ data: articles, error: null });
      return self;
    }
    // calendar_entries
    let patch: Record<string, unknown> = {};
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.update = (p: Record<string, unknown>) => {
      patch = p;
      return self;
    };
    self.is = () => Promise.resolve({ data: entries, error: null });
    self.eq = (_c: string, v: string) => {
      if (Object.keys(patch).length) {
        updates.push({ id: v, patch });
        return {
          select: () => ({ maybeSingle: async () => ({ data: { keyword_id: "kw-x" }, error: null }) }),
        };
      }
      return self;
    };
    return self;
  };
  return { db: { from } as unknown as SupabaseClient, updates, keywordUpdates };
}

describe("closeCoveredEntries", () => {
  it("closes an entry whose keyword row already has an article", async () => {
    const c = client(
      [{ id: "ce-1", keyword_id: "kw-1", keyword: "business directory websites" }],
      [{ id: "art-1", keyword_id: "kw-1", keyword: "business directory websites" }],
    );
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(1);
    expect(c.updates[0]).toEqual({ id: "ce-1", patch: { article_id: "art-1", status: "scheduled" } });
  });

  it("matches on the term when the entry has no keyword row", async () => {
    const c = client(
      [{ id: "ce-1", keyword_id: null, keyword: "Free Dental Clinic Website Template" }],
      [{ id: "art-9", keyword_id: "kw-2", keyword: "free dental clinic website template" }],
    );
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(1);
    expect(c.updates[0].patch.article_id).toBe("art-9");
  });

  it("leaves an entry nobody has written", async () => {
    const c = client(
      [{ id: "ce-1", keyword_id: "kw-1", keyword: "dental clinic website design" }],
      [{ id: "art-1", keyword_id: "kw-9", keyword: "something else" }],
    );
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(0);
    expect(c.updates).toHaveLength(0);
  });

  it("closes only the covered ones when the calendar holds both", async () => {
    const c = client(
      [
        { id: "ce-1", keyword_id: "kw-1", keyword: "written already" },
        { id: "ce-2", keyword_id: "kw-2", keyword: "still to write" },
      ],
      [{ id: "art-1", keyword_id: "kw-1", keyword: "written already" }],
    );
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(1);
    expect(c.updates.map((u) => u.id)).toEqual(["ce-1"]);
  });

  it("does nothing on an empty calendar, and reads no articles for it", async () => {
    const c = client([], [{ id: "art-1", keyword_id: "kw-1", keyword: "x" }]);
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(0);
  });

  it("does nothing when the workspace has never published", async () => {
    const c = client([{ id: "ce-1", keyword_id: "kw-1", keyword: "x" }], []);
    expect(await closeCoveredEntries(c.db, "ws-1")).toBe(0);
  });
});

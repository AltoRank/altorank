import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A keyword typed by hand is stored as a searcher would have typed it, once.
 *
 * 2026-09-09: "shipping on shopify " went into the table with its trailing
 * space, which the unique index on (workspace, term) then treated as a
 * different keyword from "shipping on shopify". And a refused add - a
 * duplicate, a term of only spaces - threw, which the dialog swallowed into
 * console.error: nothing closed, nothing said.
 */

type Row = Record<string, unknown>;
const rows: Row[] = [];
const inserted: Row[] = [];
let insertError: { code: string; message: string } | null = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          ilike: (_col: string, pattern: string) => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: rows.find((r) => String(r.term).toLowerCase() === pattern.toLowerCase()) ?? null,
              }),
            }),
          }),
        }),
      }),
      insert: async (row: Row) => {
        if (insertError) return { error: insertError };
        inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));

import { createKeyword } from "../keywords";

const WS = "1b4e28ba-2fa1-4a4b-8a2e-1c0e5f6d7a8b";
const form = (term: string, intent = "info") => {
  const fd = new FormData();
  fd.set("workspace_id", WS);
  fd.set("term", term);
  fd.set("intent", intent);
  return fd;
};

beforeEach(() => {
  rows.length = 0;
  inserted.length = 0;
  insertError = null;
});

describe("createKeyword", () => {
  it("stores the term as a searcher would type it: trimmed, one space between words", async () => {
    const r = await createKeyword(form("  shipping   on shopify \n"));
    expect(r).toEqual({ ok: true, term: "shipping on shopify" });
    expect(inserted[0]).toMatchObject({ term: "shipping on shopify", source_type: "manual", volume: null, difficulty: null });
  });

  it("refuses a term of only whitespace, with a sentence rather than a throw", async () => {
    const r = await createKeyword(form("   "));
    expect(r).toEqual({ ok: false, error: "Enter a keyword." });
    expect(inserted).toHaveLength(0);
  });

  it("refuses a duplicate, case-insensitively, and names the one already there", async () => {
    rows.push({ term: "Best CRM", status: "planned" });
    const r = await createKeyword(form("best crm"));
    expect(r).toEqual({ ok: false, error: '"Best CRM" is already tracked (planned).' });
    expect(inserted).toHaveLength(0);
  });

  it("turns the index's own refusal into the same sentence", async () => {
    insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    const r = await createKeyword(form("best crm"));
    expect(r).toEqual({ ok: false, error: '"best crm" is already tracked.' });
  });
});

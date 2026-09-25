import { describe, it, expect, vi, beforeEach } from "vitest";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({
  post,
  hasDataForSEOCredentials: () => true,
  DataForSEOError: class DataForSEOError extends Error {
    constructor(message: string, public statusCode = 0) {
      super(message);
    }
  },
}));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { DataForSEOError } from "@/lib/seo/client";
import { dfs, ctx, quiet, issue, kvOf, tableOf, textOf, item } from "./paid-helpers";
import { plagiarismChecker as tool, pickSentences, toPhrase, snippetShows, splitSentences } from "../tools/plagiarism-checker";

beforeEach(() => {
  post.mockReset();
});
const endpoints = () => post.mock.calls.map((c) => c[0] as string);

const LONG1 = "Composting at home turns kitchen scraps and garden waste into a dark and crumbly soil improver within a few months.";
const LONG2 = "The pile needs a mix of brown and green materials, kept about as damp as a wrung-out sponge.";
const TEXT = `Short one. ${LONG1} Read more at https://example.com/about for details and news here. ${LONG2}`;

describe("plagiarism-checker", () => {
  it("searches each distinctive sentence as an exact phrase and reports the pages", async () => {
    post.mockImplementation(async (_e: string, tasks: Array<{ keyword: string }>) =>
      tasks[0].keyword.includes("Composting at home")
        ? dfs({ items: [{ type: "organic", url: "https://copy.example/a", title: "Copy", description: `... ${LONG1} ...` }, { type: "people_also_ask" }] })
        : dfs({ items: [] }),
    );
    const blocks = await tool.run(tool.input.parse({ text: TEXT }), ctx());
    const keywords = post.mock.calls.map((c) => (c[1] as Array<{ keyword: string }>)[0].keyword);
    expect(keywords).toHaveLength(2);
    expect(keywords.every((k) => k.startsWith('"') && k.endsWith('"'))).toBe(true);
    expect(post.mock.calls[0][0]).toBe("/serp/google/organic/live/regular");

    const k = kvOf(blocks);
    expect(item(k, "Found on other pages")?.value).toBe("1 of 2 sentences");
    expect(tableOf(blocks, "Pages whose Google snippet shows the phrase").rows).toEqual([[1, "https://copy.example/a", "Copy"]]);
    expect(textOf(blocks, "What this checked")!.text).toMatch(/exact-phrase Google search/);
    expect(tool.cacheTtlMs).toBe(0);
  });

  it("picks at most five, longest first, skipping boilerplate, in text order", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} has ${"many ".repeat(i + 4)}distinctive words in it.`);
    const picked = pickSentences(sentences.join(" ") + " Copyright 2026 Example Ltd, all rights reserved by the owner.");
    expect(picked).toHaveLength(5);
    expect(picked[0]).toMatch(/number 3/);
    expect(picked.some((p) => /Copyright/.test(p))).toBe(false);
    expect(splitSentences("One two. Three four!\nFive")).toEqual(["One two.", "Three four!", "Five"]);
  });

  it("cuts a phrase to 30 words and removes quote marks", () => {
    const phrase = toPhrase(`He said "${"word ".repeat(40)}end."`);
    expect(phrase.split(" ")).toHaveLength(30);
    expect(phrase).not.toMatch(/"/);
  });

  it("needs ten words in a row in the snippet to say it shows the phrase", () => {
    expect(snippetShows("the quick brown fox jumps over", "the quick brown fox jumps over the lazy dog every single day")).toBe(false);
    expect(snippetShows("x The quick brown fox jumps over the lazy dog every single day y", "the quick brown fox jumps over the lazy dog every single day")).toBe(true);
  });

  it("keeps going when one search fails, and is upstream when all do", async () => {
    const restore = quiet();
    post.mockImplementationOnce(async () => {
      throw new Error("40101");
    }).mockResolvedValueOnce(dfs({ items: [] }));
    const blocks = await tool.run(tool.input.parse({ text: `${LONG1} ${LONG2}` }), ctx());
    expect(item(kvOf(blocks), "Sentences checked")).toMatchObject({ value: "1 of 2 chosen", status: "warn" });
    post.mockReset();
    post.mockImplementation(async () => {
      throw new Error("down");
    });
    await expect(tool.run(tool.input.parse({ text: LONG1 }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("reads 40101 on an exact phrase as no match, asks for one attempt, and is not upstream", async () => {
    post.mockImplementation(async () => {
      throw new DataForSEOError("Internal SE Server Error.", 40101);
    });
    const blocks = await tool.run(tool.input.parse({ text: `${LONG1} ${LONG2}` }), ctx());
    const k = kvOf(blocks);
    expect(item(k, "Sentences checked")).toMatchObject({ value: "2 of 2 chosen", status: "info" });
    expect(item(k, "Found on other pages")).toMatchObject({ value: "none of the checked sentences", status: "pass" });
    expect(post.mock.calls.every((c) => (c[2] as { maxAttempts?: number })?.maxAttempts === 1)).toBe(true);
  });

  it("does not count pages whose snippet lacks the phrase (Google's relaxed results)", async () => {
    post.mockImplementation(async () =>
      dfs({ items: [{ type: "organic", url: "https://game.example/zzz", title: "Unrelated", description: "A video game wiki page about something else." }] }),
    );
    const blocks = await tool.run(tool.input.parse({ text: `${LONG1} ${LONG2}` }), ctx());
    const k = kvOf(blocks);
    expect(item(k, "Found on other pages")).toMatchObject({ value: "none of the checked sentences", status: "pass" });
    expect(item(k, "Loose results only")?.value).toMatch(/^2 sentences/);
    expect(tableOf(blocks, "Other pages Google returned (the phrase is not in their snippet)").rows).toHaveLength(2);
    expect(blocks.some((b) => b.type === "table" && b.title === "Pages whose Google snippet shows the phrase")).toBe(false);
  });

  it("refuses text with no sentence long enough to search, without calling out", async () => {
    await expect(tool.run(tool.input.parse({ text: "Too short. Also short." }), ctx())).rejects.toMatchObject({ code: "invalid_input" });
    expect(endpoints()).toEqual([]);
    expect(issue(tool.input, { text: "a".repeat(20_001) })).toMatch(/20,000/);
  });
});

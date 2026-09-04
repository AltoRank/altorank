import { describe, it, expect, vi, beforeEach } from "vitest";

// Two things this pins. First, `checks` is a map whose booleans are TRUE when
// the fault is PRESENT; reading them as "passed" inverts every finding on
// every page. Second, rendering costs 34x a plain read ($0.0051 against
// $0.00015, measured 2026-09-04), so nothing may turn it on by accident.

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({ post, hasDataForSEOCredentials: () => true }));

const { fetchInstantPage, describeFailing } = await import("../onpage");

const item = {
  url: "https://x.co/a",
  status_code: 200,
  onpage_score: 98.9,
  click_depth: 2,
  broken_links: 1,
  duplicate_title: true,
  checks: {
    no_h1_tag: false,
    no_image_alt: true,
    low_readability_rate: true,
    some_future_check_we_have_no_words_for: true,
  },
  meta: {
    title: "  A Title  ",
    title_length: 7,
    description: "A description",
    canonical: "https://x.co/a",
    internal_links_count: 55,
    external_links_count: 26,
    htags: { h1: ["A Title"], h2: ["One", "Two"] },
    content: { plain_text_word_count: 1305 },
  },
};

const respond = (i: unknown) => post.mockResolvedValue({ tasks: [{ result: [{ items: [i] }] }] });

beforeEach(() => post.mockReset());

describe("fetchInstantPage", () => {
  it("reports the checks that are FAILING, not the ones present in the map", async () => {
    respond(item);
    const f = (await fetchInstantPage("https://x.co/a"))!;
    expect(f.failing).toEqual([
      "low_readability_rate",
      "no_image_alt",
      "some_future_check_we_have_no_words_for",
    ]);
    expect(f.failing).not.toContain("no_h1_tag");
  });

  it("does not pay for a browser unless asked", async () => {
    respond(item);
    await fetchInstantPage("https://x.co/a");
    expect(post.mock.calls[0][1][0]).toMatchObject({ enable_javascript: false });
    expect(post.mock.calls[0][1][0]).not.toHaveProperty("enable_browser_rendering");
  });

  it("turns rendering on only when told, and says it did", async () => {
    respond(item);
    const f = (await fetchInstantPage("https://x.co/a", { javascript: true }))!;
    expect(post.mock.calls[0][1][0]).toMatchObject({
      enable_javascript: true,
      enable_browser_rendering: true,
    });
    expect(f.rendered).toBe(true);
  });

  it("normalises the facts a page offers", async () => {
    respond(item);
    const f = (await fetchInstantPage("https://x.co/a"))!;
    expect(f.title).toBe("A Title");
    expect(f.h1).toEqual(["A Title"]);
    expect(f.h2).toHaveLength(2);
    expect(f.wordCount).toBe(1305);
    expect(f.internalLinks).toBe(55);
    expect(f.externalLinks).toBe(26);
    expect(f.duplicateTitle).toBe(true);
    expect(f.clickDepth).toBe(2);
    expect(f.onPageScore).toBe(98.9);
  });

  it("keeps an absent number null rather than calling it zero", async () => {
    respond({ url: "https://x.co/b", status_code: 200, meta: {} });
    const f = (await fetchInstantPage("https://x.co/b"))!;
    expect(f.wordCount).toBeNull();
    expect(f.internalLinks).toBeNull();
    expect(f.onPageScore).toBeNull();
    expect(f.h1).toEqual([]);
  });

  it("returns null when the task came back empty", async () => {
    post.mockResolvedValue({ tasks: [{ result: [] }] });
    expect(await fetchInstantPage("https://x.co/c")).toBeNull();
  });
});

describe("describeFailing", () => {
  it("shows only the failures we have human words for", async () => {
    respond(item);
    const f = (await fetchInstantPage("https://x.co/a"))!;
    const described = describeFailing(f);
    expect(described.map((d) => d.label)).toEqual(["Hard to read", "Images without alt text"]);
    // A provider identifier must never reach the interface.
    expect(described.some((d) => d.id.startsWith("some_future"))).toBe(false);
  });
});

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
    // Healthy: true means the good property holds.
    is_https: true,
    canonical: true,
    has_html_doctype: true,
    seo_friendly_url: true,
    // Faults: true means the problem is present.
    no_image_alt: true,
    low_readability_rate: true,
    // False, so neither.
    no_h1_tag: false,
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
  it("separates the checks that are true from the ones that are problems", async () => {
    // The trap: polarity lives in the name and the two kinds are mixed.
    // `is_https` true means the page IS secure; `no_image_alt` true means it
    // is NOT fine. Observed on fitsuite.co: 50 of 50 pages reported is_https
    // and 49 reported canonical, which reads as a wholly broken site if the
    // true-set is taken as the failure list.
    respond(item);
    const f = (await fetchInstantPage("https://x.co/a"))!;
    expect(f.checksTrue).toContain("is_https");
    expect(f.checksTrue).toContain("canonical");
    expect(f.faults).toEqual(["low_readability_rate", "no_image_alt"]);
    expect(f.faults).not.toContain("is_https");
    expect(f.faults).not.toContain("canonical");
    // A check that is false is neither.
    expect(f.checksTrue).not.toContain("no_h1_tag");
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
    // Neither a healthy check nor a raw identifier may reach the interface.
    expect(described.some((d) => d.id === "is_https")).toBe(false);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { creditsForDR, verifyPlacementLive } from "../exchange";

// These cases were first run against real HTTP (a local fixture server and live
// sites) and only then pinned here. Mocked fetch alone would prove the code
// agrees with itself, which is exactly the failure mode that let two DataForSEO
// parsers ship returning nothing.

describe("creditsForDR", () => {
  it("prices each tier at its boundaries", () => {
    expect([0, 20].map(creditsForDR)).toEqual([1, 1]);
    expect([21, 40].map(creditsForDR)).toEqual([2, 2]);
    expect([41, 60].map(creditsForDR)).toEqual([4, 4]);
    expect([61, 80].map(creditsForDR)).toEqual([8, 8]);
    expect([81, 100].map(creditsForDR)).toEqual([16, 16]);
  });

  it("refuses to price an unmeasured DR instead of using the cheapest tier", () => {
    expect(creditsForDR(null)).toBeNull();
    expect(creditsForDR(undefined)).toBeNull();
  });

  it("still prices a genuinely measured zero", () => {
    // A brand-new domain really can be DR 0. That is a reading, not a blank.
    expect(creditsForDR(0)).toBe(1);
  });
});

const TARGET = "https://limineer.com/venture-building";

function mockPage(html: string, init?: { status?: number; headers?: Record<string, string> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(html, {
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("verifyPlacementLive", () => {
  it("accepts a live, indexable, nofollow sponsored link", async () => {
    mockPage(
      `<a href="${TARGET}" rel="noopener noreferrer nofollow sponsored">venture builders</a>`,
    );
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(true);
    expect(v.rel).toContain("sponsored");
  });

  it("matches the target across scheme, case and trailing slash", async () => {
    mockPage(`<a href="http://LIMINEER.com/venture-building/" rel="sponsored nofollow">x</a>`);
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(true);
  });

  it("rejects a dofollow placement", async () => {
    mockPage(`<a href="${TARGET}">venture builders</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/nofollow and sponsored/);
  });

  it("rejects nofollow without sponsored", async () => {
    mockPage(`<a href="${TARGET}" rel="nofollow">venture builders</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing sponsored/);
  });

  it("rejects a correct link on a noindex page", async () => {
    mockPage(
      `<head><meta name="robots" content="noindex, follow"></head>` +
        `<a href="${TARGET}" rel="nofollow sponsored">x</a>`,
    );
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(false);
  });

  it("rejects a correct link behind an X-Robots-Tag noindex header", async () => {
    mockPage(`<a href="${TARGET}" rel="nofollow sponsored">x</a>`, {
      headers: { "x-robots-tag": "noindex" },
    });
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(false);
  });

  it("rejects a page that does not carry the link at all", async () => {
    mockPage(`<a href="https://example.com/other" rel="nofollow sponsored">x</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no link to the target/);
  });

  it("rejects a non-200 page", async () => {
    mockPage("not found", { status: 404 });
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.httpStatus).toBe(404);
  });

  it("rejects an article that was never published", async () => {
    const v = await verifyPlacementLive(null, TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no published URL/);
  });

  it("rejects rather than throws when the host is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/could not fetch/);
  });
});

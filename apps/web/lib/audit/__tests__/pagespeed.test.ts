import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchPageSpeedDetailed, fetchPageSpeed } from "../pagespeed";

const LIGHTHOUSE = {
  lighthouseResult: {
    categories: { performance: { score: 0.92 } },
    audits: {
      "first-contentful-paint": { numericValue: 2600 },
      "largest-contentful-paint": { numericValue: 2600 },
      "cumulative-layout-shift": { numericValue: 0.067 },
      "total-blocking-time": { numericValue: 0 },
      "speed-index": { numericValue: 3100 },
    },
  },
};

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL) => impl(String(input))));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.PAGESPEED_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.PAGESPEED_API_KEY;
  else process.env.PAGESPEED_API_KEY = savedKey;
});

describe("fetchPageSpeedDetailed — success", () => {
  it("maps Lighthouse audits to Core Web Vitals", async () => {
    mockFetch(() => json(LIGHTHOUSE));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Matches a real response for altorank.co at the time the key was added.
    expect(out.result.performanceScore).toBe(92);
    expect(out.result.largestContentfulPaint).toBe(2600);
    expect(out.result.cumulativeLayoutShift).toBeCloseTo(0.067);
  });

  it("sends the API key when one is configured", async () => {
    process.env.PAGESPEED_API_KEY = "test-key-123";
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return json(LIGHTHOUSE);
    });
    await fetchPageSpeedDetailed("https://altorank.co");
    expect(seen).toContain("key=test-key-123");
  });

  it("omits the key parameter entirely when unset, rather than sending an empty one", async () => {
    delete process.env.PAGESPEED_API_KEY;
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return json(LIGHTHOUSE);
    });
    await fetchPageSpeedDetailed("https://altorank.co");
    expect(seen).not.toContain("key=");
  });

  it("passes the requested strategy through", async () => {
    let seen = "";
    mockFetch((url) => {
      seen = url;
      return json(LIGHTHOUSE);
    });
    await fetchPageSpeedDetailed("https://altorank.co", "desktop");
    expect(seen).toContain("strategy=desktop");
  });
});

describe("fetchPageSpeedDetailed — distinguishing failures", () => {
  // The point of the rewrite: these four used to be one indistinguishable null,
  // so the trivially fixable case looked the same as the unfixable one.

  it("reports a missing key as the cause of a rate limit", async () => {
    delete process.env.PAGESPEED_API_KEY;
    mockFetch(() => json({ error: { message: "Rate Limit Exceeded" } }, 429));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    expect(out).toMatchObject({ ok: false, kind: "unavailable" });
    if (out.ok) return;
    expect(out.detail).toContain("PAGESPEED_API_KEY");
  });

  it("reports quota exhaustion differently when a key is present", async () => {
    process.env.PAGESPEED_API_KEY = "test-key-123";
    mockFetch(() => json({ error: { message: "Quota exceeded" } }, 429));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    if (out.ok) throw new Error("expected failure");
    expect(out.kind).toBe("unavailable");
    expect(out.detail).toContain("quota");
    expect(out.detail).not.toContain("set PAGESPEED_API_KEY");
  });

  it("surfaces a rejected key with Google's own message", async () => {
    process.env.PAGESPEED_API_KEY = "bad-key";
    mockFetch(() => json({ error: { message: "API key not valid" } }, 400));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    if (out.ok) throw new Error("expected failure");
    expect(out.kind).toBe("unavailable");
    expect(out.detail).toContain("API key not valid");
  });

  it("treats an unanalysable URL as a fact about the site, not our config", async () => {
    mockFetch(() => json({ error: { message: "Unable to reach the origin" } }, 500));
    const out = await fetchPageSpeedDetailed("https://broken.example");
    if (out.ok) throw new Error("expected failure");
    expect(out.kind).toBe("failed");
  });

  it("handles a missing Lighthouse result", async () => {
    mockFetch(() => json({}));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    if (out.ok) throw new Error("expected failure");
    expect(out.detail).toContain("no Lighthouse result");
  });

  it("handles a non-JSON error body without throwing", async () => {
    mockFetch(() => new Response("<html>502</html>", { status: 502 }));
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    if (out.ok) throw new Error("expected failure");
    expect(out.detail).toContain("502");
  });

  it("reports a network error rather than throwing", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const out = await fetchPageSpeedDetailed("https://altorank.co");
    if (out.ok) throw new Error("expected failure");
    expect(out.kind).toBe("failed");
    expect(out.detail).toContain("ECONNREFUSED");
  });
});

describe("fetchPageSpeed — back-compatible wrapper", () => {
  it("returns the result on success", async () => {
    mockFetch(() => json(LIGHTHOUSE));
    expect((await fetchPageSpeed("https://altorank.co"))?.performanceScore).toBe(92);
  });

  it("returns null on any failure, preserving the old contract", async () => {
    mockFetch(() => json({ error: { message: "nope" } }, 429));
    expect(await fetchPageSpeed("https://altorank.co")).toBeNull();
  });
});

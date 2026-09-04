import { describe, it, expect, afterEach } from "vitest";
import { fetchPageSpeedDetailed } from "../pagespeed";

// A real analysis run timed out at 90s on fitsuite.co; twenty minutes later
// the same URL answered in 32s (mobile) and 23s (desktop). The call is not
// slow, it is occasionally queued - which a longer wait does not fix and a
// second attempt does. These pin what gets retried and what does not, because
// retrying a rejected key just wastes another 60 seconds.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PAGESPEED_API_KEY;
});

const lighthouse = {
  lighthouseResult: {
    categories: { performance: { score: 0.67 } },
    audits: { "largest-contentful-paint": { numericValue: 2400 } },
  },
};

/** Each entry is one response, consumed in order. */
function serve(...responses: Array<Response | Error>) {
  let i = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("fetchPageSpeedDetailed", () => {
  it("retries a timeout and keeps the second answer", async () => {
    const calls = serve(aborted(), json(lighthouse));
    const out = await fetchPageSpeedDetailed("https://x.co");
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
    if (out.ok) expect(out.result.performanceScore).toBe(67);
  });

  it("gives up after two timeouts, and says it tried twice", async () => {
    const calls = serve(aborted(), aborted());
    const out = await fetchPageSpeedDetailed("https://x.co");
    expect(calls).toHaveLength(2);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toBe("PageSpeed timed out after 60s, twice");
  });

  it("retries a 5xx from Google", async () => {
    const calls = serve(json({ error: { message: "backend error" } }, 503), json(lighthouse));
    expect((await fetchPageSpeedDetailed("https://x.co")).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not retry an exhausted quota", async () => {
    process.env.PAGESPEED_API_KEY = "k";
    const calls = serve(json({ error: { message: "Quota exceeded" } }, 429));
    const out = await fetchPageSpeedDetailed("https://x.co");
    expect(calls).toHaveLength(1);
    if (!out.ok) {
      expect(out.kind).toBe("unavailable");
      expect(out.detail).toContain("quota exhausted");
    }
  });

  it("does not retry a rejected request", async () => {
    const calls = serve(json({ error: { message: "API key not valid" } }, 403));
    const out = await fetchPageSpeedDetailed("https://x.co");
    expect(calls).toHaveLength(1);
    if (!out.ok) expect(out.detail).toContain("API key not valid");
  });

  it("does not retry a page Lighthouse could not analyse", async () => {
    // A second identical request produces the same answer 60 seconds later.
    const calls = serve(json({}));
    const out = await fetchPageSpeedDetailed("https://x.co");
    expect(calls).toHaveLength(1);
    if (!out.ok) expect(out.detail).toBe("PageSpeed returned no Lighthouse result");
  });

  it("succeeds on the first attempt without a second call", async () => {
    const calls = serve(json(lighthouse));
    expect((await fetchPageSpeedDetailed("https://x.co")).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

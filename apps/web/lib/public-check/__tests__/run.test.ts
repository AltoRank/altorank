import { describe, it, expect } from "vitest";
import { ReadinessDeadline, type FetchedResource } from "@/lib/audit/agent-readiness";
import { deadlineFetcher, runPublicCheck, isCacheable, isFresh, CACHE_TTL_MS } from "../run";

const GOOD_HOME =
  `<html><head><title>Acme</title><meta name="description" content="Acme" />` +
  `<script type="application/ld+json">{"@type":"Organization"}</script>` +
  `</head><body><h1>Acme</h1></body></html>`;

/** A clock the test advances by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("deadlineFetcher", () => {
  it("hands each fetch only the time that is left", async () => {
    const c = clock();
    const seen: number[] = [];
    const impl = async (_url: string, timeoutMs: number): Promise<FetchedResource> => {
      seen.push(timeoutMs);
      return { status: 200, headers: {}, body: "" };
    };
    const fetcher = deadlineFetcher(c.now() + 20_000, impl, c.now);
    await fetcher("https://a.example/");
    c.advance(15_000);
    await fetcher("https://a.example/robots.txt");
    expect(seen).toEqual([12_000, 5_000]);
  });

  it("throws ReadinessDeadline once the deadline has passed", async () => {
    const c = clock();
    const fetcher = deadlineFetcher(c.now() + 1_000, async () => ({ status: 200, headers: {}, body: "" }), c.now);
    c.advance(1_000);
    await expect(fetcher("https://a.example/")).rejects.toBeInstanceOf(ReadinessDeadline);
  });

  it("reports a fetch that died at the deadline as a deadline, not as unreachable", async () => {
    const c = clock();
    const impl = async (): Promise<FetchedResource> => {
      c.advance(3_000); // the fetch ran out the clock
      return { status: 0, headers: {}, body: "" };
    };
    const fetcher = deadlineFetcher(c.now() + 2_000, impl, c.now);
    await expect(fetcher("https://a.example/sitemap.xml")).rejects.toBeInstanceOf(ReadinessDeadline);
  });

  it("passes a genuine unreachable through when time remains", async () => {
    const c = clock();
    const fetcher = deadlineFetcher(c.now() + 20_000, async () => ({ status: 0, headers: {}, body: "" }), c.now);
    await expect(fetcher("https://a.example/")).resolves.toMatchObject({ status: 0 });
  });
});

describe("runPublicCheck", () => {
  it("returns a partial result with unknowns when the site runs the clock out", async () => {
    const c = clock();
    const impl = async (url: string): Promise<FetchedResource> => {
      if (url.endsWith("/")) return { status: 200, headers: {}, body: GOOD_HOME };
      if (url.endsWith("/robots.txt")) return { status: 200, headers: {}, body: "User-agent: *\nAllow: /\nSitemap: https://a.example/s.xml\n" };
      // llms.txt hangs until the deadline.
      c.advance(30_000);
      return { status: 0, headers: {}, body: "" };
    };
    const data = await runPublicCheck("a.example", { fetchImpl: impl, now: c.now, deadlineMs: 25_000 });
    expect(data.partial).toBe(true);
    // robots, crawlers, sitemap, structured data, entity ran; the rest did not.
    expect(data.known).toBe(5);
    expect(data.checks.find((ch) => ch.id === "machine_readable")?.status).toBe("unknown");
    expect(data.checks.find((ch) => ch.id === "entity_schema")?.status).toBe("pass");
    expect(data.score).toBe(100);
    expect(isCacheable(data)).toBe(false);
  });

  it("completes and is cacheable when the site answers in time", async () => {
    const c = clock();
    const impl = async (url: string): Promise<FetchedResource> => {
      c.advance(100);
      if (url.endsWith("/")) return { status: 200, headers: {}, body: GOOD_HOME };
      if (url.endsWith("/robots.txt")) return { status: 200, headers: {}, body: "User-agent: *\nAllow: /\nSitemap: https://a.example/s.xml\n" };
      return { status: 404, headers: {}, body: "" };
    };
    const data = await runPublicCheck("a.example", { fetchImpl: impl, now: c.now });
    expect(data.partial).toBe(false);
    expect(data.known).toBe(9);
    expect(data.passed).toBe(7); // llms.txt and content-signal missing
    expect(isCacheable(data)).toBe(true);
    expect(data.domain).toBe("a.example");
  });

  it("is not cacheable when the site could not be checked", async () => {
    const data = await runPublicCheck("a.example", {
      fetchImpl: async () => ({ status: 0, headers: {}, body: "" }),
      now: clock().now,
    });
    expect(data.error).toBe("unreachable over https");
    expect(data.score).toBeNull();
    expect(isCacheable(data)).toBe(false);
  });
});

describe("isFresh", () => {
  it("is fresh inside the TTL and stale at it", () => {
    const at = new Date("2026-09-04T10:00:00Z").getTime();
    expect(isFresh("2026-09-04T10:00:00Z", at + CACHE_TTL_MS - 1)).toBe(true);
    expect(isFresh("2026-09-04T10:00:00Z", at + CACHE_TTL_MS)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import {
  AI_CRAWLERS,
  blockedCrawlers,
  collectJsonLdTypes,
  parseRobotsGroups,
  runAgentReadiness,
  type FetchedResource,
  type ResourceFetcher,
} from "../agent-readiness";

/** Fake fetcher: exact-URL map, anything else is unreachable. */
function fakeFetcher(routes: Record<string, Partial<FetchedResource>>): ResourceFetcher {
  return async (url) => {
    const hit = routes[url];
    if (!hit) return { status: 0, headers: {}, body: "" };
    return { status: hit.status ?? 200, headers: hit.headers ?? {}, body: hit.body ?? "" };
  };
}

const ldJson = (obj: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

/** A homepage that passes every on-page check. */
const GOOD_HOME =
  `<html><head><title>Acme</title>` +
  `<meta name="description" content="Acme agency" />` +
  ldJson({ "@context": "https://schema.org", "@type": "Organization", name: "Acme" }) +
  `</head><body><h1>Acme</h1></body></html>`;

// ── collectJsonLdTypes ────────────────────────────────────────────────────────

describe("collectJsonLdTypes", () => {
  it("reads a flat block", () => {
    expect(collectJsonLdTypes(ldJson({ "@type": "Organization" }))).toEqual(["Organization"]);
  });

  it("recurses into @graph (the Yoast shape that caused the 32%-vs-94% false negative)", () => {
    const html = ldJson({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", publisher: { "@type": "Organization", name: "Acme" } },
        { "@type": "WebPage" },
      ],
    });
    expect(collectJsonLdTypes(html).sort()).toEqual(["Organization", "WebPage", "WebSite"]);
  });

  it("handles array-valued @type and multiple blocks", () => {
    const html =
      ldJson({ "@type": ["LocalBusiness", "Organization"] }) + ldJson({ "@type": "FAQPage" });
    expect(collectJsonLdTypes(html).sort()).toEqual(["FAQPage", "LocalBusiness", "Organization"]);
  });

  it("skips malformed JSON without losing valid blocks", () => {
    const html =
      `<script type="application/ld+json">{not json}</script>` + ldJson({ "@type": "Article" });
    expect(collectJsonLdTypes(html)).toEqual(["Article"]);
  });
});

// ── robots parsing ────────────────────────────────────────────────────────────

describe("blockedCrawlers", () => {
  it("reports nothing blocked for an allow-all file", () => {
    expect(blockedCrawlers("User-agent: *\nAllow: /\n")).toEqual([]);
  });

  it("blocks a specifically named bot", () => {
    const robots = "User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n";
    expect(blockedCrawlers(robots)).toEqual(["GPTBot"]);
  });

  it("wildcard Disallow / blocks every bot without a specific group", () => {
    expect(blockedCrawlers("User-agent: *\nDisallow: /\n")).toEqual([...AI_CRAWLERS]);
  });

  it("a specific Allow group overrides a blocking * group", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /\n";
    expect(blockedCrawlers(robots)).not.toContain("ClaudeBot");
    expect(blockedCrawlers(robots)).toContain("GPTBot");
  });

  it("Allow / beats Disallow / inside one group (least-restrictive tie-break)", () => {
    const robots = "User-agent: GPTBot\nDisallow: /\nAllow: /\n";
    expect(blockedCrawlers(robots)).toEqual([]);
  });

  it("empty Disallow means nothing disallowed", () => {
    expect(blockedCrawlers("User-agent: *\nDisallow:\n")).toEqual([]);
  });

  it('treats "Disallow: /*" as blocking the root', () => {
    expect(blockedCrawlers("User-agent: GPTBot\nDisallow: /*\n")).toEqual(["GPTBot"]);
  });

  it("is case-insensitive on agent names and shares rules across consecutive User-agent lines", () => {
    const robots = "User-agent: gptbot\nUser-agent: claudebot\nDisallow: /\n";
    expect(blockedCrawlers(robots)).toEqual(["GPTBot", "ClaudeBot"]);
  });

  it("ignores path-specific rules that do not affect the homepage", () => {
    const robots = "User-agent: GPTBot\nDisallow: /private/\n";
    expect(blockedCrawlers(robots)).toEqual([]);
    expect(parseRobotsGroups(robots)[0].disallowRoot).toBe(false);
  });
});

// ── the full run ──────────────────────────────────────────────────────────────

describe("runAgentReadiness", () => {
  const base = "https://acme.example";

  it("scores 100 when everything passes", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: {
        body: "User-agent: *\nAllow: /\nContent-Signal: ai-train=yes\nSitemap: https://acme.example/sitemap.xml\n",
      },
      [`${base}/llms.txt`]: { headers: { "content-type": "text/plain" }, body: "# Acme\n\n> Machine-readable index of the site." },
    }));
    expect(result.error).toBeUndefined();
    expect(result.findings).toHaveLength(9);
    expect(result.findings.every((f) => f.passed)).toBe(true);
    expect(result.score).toBe(100);
  });

  it("matches the Python scorer: three low-severity failures score 83 (altorank.co parity case)", async () => {
    // Passing everything except content_signals, single_h1, title_meta
    // earned 15 of 18 weighted points -> 83, the exact score the Python
    // checker produced for altorank.co pre-fix.
    const home =
      `<html><head>` +
      ldJson({ "@type": "Organization" }) +
      `</head><body><h1>a</h1><h1>b</h1></body></html>`;
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: home },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://acme.example/s.xml\n" },
      [`${base}/llms.txt`]: { headers: { "content-type": "text/plain" }, body: "# Acme\n\n> Machine-readable index of the site." },
    }));
    const failed = result.findings.filter((f) => !f.passed).map((f) => f.check).sort();
    expect(failed).toEqual(["content_signals", "single_h1", "title_meta"]);
    expect(result.score).toBe(83);
  });

  it("reports a refused robots.txt as inconclusive, not absent (5xx !== 404)", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { status: 503 },
      [`${base}/sitemap.xml`]: { body: "<urlset/>" },
    }));
    const robots = result.findings.find((f) => f.check === "robots_reachable");
    expect(robots?.passed).toBe(false);
    expect(robots?.detail).toContain("503");
    expect(robots?.detail).toContain("not conclusive");
    expect(robots?.detail).not.toContain("no robots.txt");
  });

  it("a genuinely missing robots.txt is reported as absent", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { status: 404 },
      [`${base}/sitemap.xml`]: { body: "<urlset/>" },
    }));
    expect(result.findings.find((f) => f.check === "robots_reachable")?.detail).toContain(
      "no robots.txt",
    );
  });

  it("flags blocked AI crawlers as the high-severity finding", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { body: "User-agent: GPTBot\nDisallow: /\nUser-agent: *\nAllow: /\n" },
    }));
    const finding = result.findings.find((f) => f.check === "ai_crawlers_allowed");
    expect(finding?.passed).toBe(false);
    expect(finding?.severity).toBe("high");
    expect(finding?.detail).toBe("blocked: GPTBot");
  });

  it("accepts markdown content negotiation as machine-readable", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME, headers: { "content-type": "text/markdown" } },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://x/s.xml" },
    }));
    const finding = result.findings.find((f) => f.check === "machine_readable");
    expect(finding?.passed).toBe(true);
    expect(finding?.detail).toBe("serves markdown");
  });


  it("rejects an llms.txt that is really a redirect to an HTML page", () => {
    // Regression: cloudflare.com and agenziabrand.it 301 /llms.txt to the
    // homepage; following the redirect yields 200 text/html, which passed.
    return runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://x/s.xml" },
      [`${base}/llms.txt`]: {
        headers: { "content-type": "text/html; charset=UTF-8" },
        body: "<html><head><title>Home</title></head><body>lots of markup here</body></html>",
      },
    })).then((result) => {
      const f = result.findings.find((x) => x.check === "machine_readable");
      expect(f?.passed).toBe(false);
    });
  });

  it("accepts a genuine plain-text llms.txt", () => {
    return runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://x/s.xml" },
      [`${base}/llms.txt`]: {
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: "# Acme\n\n> A real machine-readable index with content.",
      },
    })).then((result) => {
      expect(result.findings.find((x) => x.check === "machine_readable")?.passed).toBe(true);
    });
  });

  it("rejects an empty llms.txt", () => {
    return runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://x/s.xml" },
      [`${base}/llms.txt`]: { headers: { "content-type": "text/plain" }, body: "  " },
    })).then((result) => {
      expect(result.findings.find((x) => x.check === "machine_readable")?.passed).toBe(false);
    });
  });

  it("returns an error result for an unreachable domain", async () => {
    const result = await runAgentReadiness("gone.example", fakeFetcher({}));
    expect(result.error).toBe("unreachable over https");
    expect(result.score).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("returns an error result when the homepage 4xxes", async () => {
    const result = await runAgentReadiness("acme.example", fakeFetcher({
      [`${base}/`]: { status: 403, body: "denied" },
    }));
    expect(result.error).toBe("homepage returned 403");
  });

  it("normalizes scheme and trailing slashes off the input domain", async () => {
    const result = await runAgentReadiness("https://acme.example/", fakeFetcher({
      [`${base}/`]: { body: GOOD_HOME },
      [`${base}/robots.txt`]: { body: "User-agent: *\nAllow: /\nSitemap: https://x/s.xml" },
      [`${base}/llms.txt`]: { headers: { "content-type": "text/plain" }, body: "# Acme\n\n> Machine-readable index of the site." },
    }));
    expect(result.domain).toBe("acme.example");
    expect(result.error).toBeUndefined();
  });
});

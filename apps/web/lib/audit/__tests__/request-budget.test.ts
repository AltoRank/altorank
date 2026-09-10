import { describe, it, expect, afterEach } from "vitest";
import { crawlSite, usablePages } from "../crawler";
import { recordingFetcher } from "../agent-readiness";
import { discoverUrls } from "@/lib/seo/site-crawl";

/**
 * packhub.io rate-bans an address after ten requests in about forty seconds
 * and answers 403 (measured 2026-09-10 from a residential address: ten 200s,
 * then 403s, 200 again after the window). The onboarding minute fetched "/"
 * three times and robots.txt and the sitemap twice, and the crawl arrived
 * after the tenth request. Fewer requests, and stop when the door closes.
 */

const HTML = (title: string, links = "") =>
  `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${"words ".repeat(120)}</p>${links}</body></html>`;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A host that answers N requests, then 403s. */
function hostWithBudget(n: number) {
  let count = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); urls.push(url); count += 1;
    if (count > n) return new Response("banned", { status: 403, headers: { "content-type": "text/html" } });
    const links = ["/a", "/b", "/c", "/d", "/e", "/f"].map((p) => `<a href="https://packhub.io${p}">${p}</a>`).join("");
    return new Response(HTML(url, links), { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { urls, requests: () => count };
}

describe("crawlSite against a host that counts requests", () => {
  it("stops the moment the host starts refusing, instead of spending the rest of the budget", async () => {
    const host = hostWithBudget(3);
    const pages = await crawlSite("https://packhub.io", 40, 2, 0);
    expect(usablePages(pages)).toHaveLength(3);
    // 3 answered + 1 refused (the crawler-UA try) + 1 refused (the fallback try) = 5, then it stopped.
    expect(host.requests()).toBeLessThanOrEqual(5);
    expect(pages.at(-1)?.status).toBe(403);
    expect(pages.at(-1)?.error).toContain("rate-limits");
  });

  it("does not fetch the homepage when the caller already holds it", async () => {
    const host = hostWithBudget(100);
    const pages = await crawlSite("https://packhub.io", 1, 0, 0, { seedHtml: HTML("Seeded") });
    expect(usablePages(pages)).toHaveLength(1);
    expect(pages[0].title).toBe("Seeded");
    expect(host.requests()).toBe(0);
  });
});

describe("recordingFetcher", () => {
  it("fetches each URL once and remembers the answer", async () => {
    const host = hostWithBudget(100);
    const f = recordingFetcher(5_000);
    await f("https://packhub.io/"); await f("https://packhub.io/"); await f("https://packhub.io/robots.txt");
    expect(host.requests()).toBe(2);
    expect(f.resources.get("https://packhub.io/")?.status).toBe(200);
  });
});

describe("discoverUrls with bodies the caller already holds", () => {
  it("does not fetch robots.txt or the sitemap again", async () => {
    const host = hostWithBudget(100);
    const bodies = new Map([
      ["https://packhub.io/robots.txt", "User-agent: *\nSitemap: https://packhub.io/sitemap.xml\n"],
      ["https://packhub.io/sitemap.xml", `<urlset><url><loc>https://packhub.io/</loc></url><url><loc>https://packhub.io/product</loc></url></urlset>`],
    ]);
    const urls = await discoverUrls("packhub.io", { timeoutMs: 1000, maxUrls: 50, bodies });
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(host.requests()).toBe(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { noteRefusal, refusing, clearRefusal, resetHostCircuit } from "../host-circuit";
import { crawlSite, usablePages } from "../crawler";
import { fetchResource } from "../agent-readiness";

/**
 * packhub.io, measured 2026-09-10: ~20 requests in 40s trips a 403 that lasts
 * 15-40s, on a sliding window. Every request made while refused - a retry
 * with another agent, the next readiness resource, the pages phase - keeps it
 * over the line. After one refusal, the run goes quiet on that host.
 */
const HTML = `<html><head><title>P</title></head><body><h1>P</h1><p>${"words ".repeat(120)}</p><a href="https://packhub.io/a">a</a><a href="https://packhub.io/b">b</a></body></html>`;
const realFetch = globalThis.fetch;
beforeEach(() => resetHostCircuit());
afterEach(() => { globalThis.fetch = realFetch; resetHostCircuit(); });

describe("host circuit", () => {
  it("remembers a refusal, and forgets it when told", () => {
    expect(refusing("https://packhub.io/")).toBe(false);
    noteRefusal("https://packhub.io/x");
    expect(refusing("https://packhub.io/y")).toBe(true);
    expect(refusing("https://other.io/")).toBe(false);
    clearRefusal("https://packhub.io/");
    expect(refusing("https://packhub.io/")).toBe(false);
  });
  it("expires on its own", () => {
    noteRefusal("https://packhub.io/", 1_000);
    expect(refusing("https://packhub.io/", 30_000)).toBe(true);
    expect(refusing("https://packhub.io/", 61_001)).toBe(false);
  });
});

describe("the crawl behind a refusing host", () => {
  it("knocks twice on the first refusal, then not at all", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n += 1; return new Response("no", { status: 403, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    const pages = await crawlSite("https://packhub.io", 5, 1, 0);
    expect(usablePages(pages)).toHaveLength(0);
    expect(n).toBe(2); // crawler agent, then the reader's agent - and silence
    expect(refusing("https://packhub.io/")).toBe(true);
  });

  it("reads a page, is refused on the next, and stops without a fallback knock", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n += 1; return n === 1 ? new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 403, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    const pages = await crawlSite("https://packhub.io", 10, 1, 0);
    expect(usablePages(pages)).toHaveLength(1);
    expect(n).toBe(3); // page 1 (200), page 2 (403), page 2 fallback (403) - then stop
  });
});

describe("the readiness check behind a refusing host", () => {
  it("answers from the circuit instead of the network", async () => {
    let n = 0;
    globalThis.fetch = (async () => { n += 1; return new Response("no", { status: 403 }); }) as typeof fetch;
    const a = await fetchResource("https://packhub.io/", 1000);
    const b = await fetchResource("https://packhub.io/robots.txt", 1000);
    const c = await fetchResource("https://packhub.io/sitemap.xml", 1000);
    expect([a.status, b.status, c.status]).toEqual([403, 403, 403]);
    expect(n).toBe(2); // one resource, two agents; the other two never left
  });
});

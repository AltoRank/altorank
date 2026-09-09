import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { crawlSite, usablePages, FALLBACK_UA } from "../crawler";
import { fetchResource } from "../agent-readiness";

/**
 * packhub.io from Vercel, 2026-09-09: HTTP 403 for the crawler and the
 * readiness check, 200 for the wizard's reader in the same invocation. A bot
 * rule on "Mozilla/5.0 (compatible; ...)" from a datacenter address. Two
 * onboarding runs declared the site unreadable on the strength of it.
 */

const HTML = `<html><head><title>PackHub</title></head><body><h1>Scan-driven packout</h1><p>${"words ".repeat(200)}</p></body></html>`;

function serverThatRefusesCompatibleAgents() {
  const calls: { url: string; ua: string }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const ua = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
    calls.push({ url, ua });
    if (ua.startsWith("Mozilla/5.0 (compatible;")) return new Response("forbidden", { status: 403, headers: { "content-type": "text/html" } });
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
  };
  return { calls, impl };
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("crawlSite behind a bot rule", () => {
  let server: ReturnType<typeof serverThatRefusesCompatibleAgents>;
  beforeEach(() => { server = serverThatRefusesCompatibleAgents(); globalThis.fetch = server.impl as typeof fetch; });

  it("reads the page on the second try, the way the wizard's reader asks", async () => {
    const pages = await crawlSite("https://packhub.io", 1, 0, 0);
    expect(usablePages(pages)).toHaveLength(1);
    expect(pages[0].status).toBe(200);
    expect(pages[0].h1).toEqual(["Scan-driven packout"]);
  });

  it("asks the polite way first and the fallback way second", async () => {
    await crawlSite("https://packhub.io", 1, 0, 0);
    expect(server.calls.map((c) => c.ua)).toEqual([expect.stringContaining("AltoRank-Auditor"), FALLBACK_UA]);
  });

  it("keeps the real answer when the fallback is refused too", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch;
    const pages = await crawlSite("https://packhub.io", 1, 0, 0);
    expect(usablePages(pages)).toHaveLength(0);
    expect(pages[0].status).toBe(403);
  });

  it("does not second-guess a site that answered", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { calls.push(String((init?.headers as Record<string, string>)["User-Agent"])); return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    await crawlSite("https://packhub.io", 1, 0, 0);
    expect(calls).toHaveLength(1);
  });
});

describe("readiness fetchResource behind the same rule", () => {
  it("reads the resource on the second try", async () => {
    const server = serverThatRefusesCompatibleAgents(); globalThis.fetch = server.impl as typeof fetch;
    const r = await fetchResource("https://packhub.io/", 5_000);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Scan-driven packout");
    expect(server.calls.map((c) => c.ua)).toEqual([expect.stringContaining("AgentReadiness"), FALLBACK_UA]);
  });
});

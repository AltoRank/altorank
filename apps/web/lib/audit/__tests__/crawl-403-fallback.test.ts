import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { crawlSite, usablePages, FALLBACK_UA } from "../crawler";
import { fetchResource } from "../agent-readiness";
import { resetHostCircuit } from "../host-circuit";

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
afterEach(() => { globalThis.fetch = realFetch; resetHostCircuit(); });

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

/**
 * A SiteGround-hosted signup, 2026-11-04: no 403 to retry on. The socket was
 * closed under every "Mozilla/5.0 (compatible; ...)" request, and the reader's
 * agent got 200 in the same minute.
 */
function dropped(code = "UND_ERR_SOCKET") {
  return Object.assign(new TypeError("fetch failed"), { cause: { code, message: "other side closed" } });
}

function serverThatDropsCompatibleAgents() {
  const calls: string[] = [];
  const impl = async (_input: string | URL | Request, init?: RequestInit) => {
    const ua = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
    calls.push(ua);
    if (ua.startsWith("Mozilla/5.0 (compatible;")) throw dropped();
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
  };
  return { calls, impl };
}

describe("crawlSite when the host drops the connection", () => {
  it("reads the page on the second try, the way the wizard's reader asks", async () => {
    const server = serverThatDropsCompatibleAgents(); globalThis.fetch = server.impl as typeof fetch;
    const pages = await crawlSite("https://paint.example", 1, 0, 0);
    expect(usablePages(pages)).toHaveLength(1);
    expect(server.calls).toEqual([expect.stringContaining("AltoRank-Auditor"), FALLBACK_UA]);
  });

  it("keeps the reason when the second try is dropped too", async () => {
    globalThis.fetch = (async () => { throw dropped(); }) as typeof fetch;
    const pages = await crawlSite("https://paint.example", 1, 0, 0);
    expect(pages[0]).toMatchObject({ status: 0, error: "UND_ERR_SOCKET" });
  });

  it("does not retry a host that does not exist", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw dropped("ENOTFOUND"); }) as typeof fetch;
    const pages = await crawlSite("https://nowhere.example", 1, 0, 0);
    expect(calls).toBe(1);
    expect(pages[0].error).toBe("host not found");
  });

  it("the readiness check reads the resource on the second try too", async () => {
    const server = serverThatDropsCompatibleAgents(); globalThis.fetch = server.impl as typeof fetch;
    const r = await fetchResource("https://paint.example/", 5_000);
    expect(r.status).toBe(200);
    expect(server.calls).toEqual([expect.stringContaining("AgentReadiness"), FALLBACK_UA]);
  });
});

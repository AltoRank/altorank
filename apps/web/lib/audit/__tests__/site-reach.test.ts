import { afterEach, describe, expect, it } from "vitest";
import { siteReach } from "../site-reach";
import { resetHostCircuit } from "../host-circuit";

// The check the wizard makes before auto-start begins a run: the homepage,
// fetched the way the run's crawl fetches it.

const HTML = `<html><head><title>Paint Co</title></head><body><h1>Pitture</h1></body></html>`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetHostCircuit(); });

function answer(status: number, headers: Record<string, string> = { "content-type": "text/html" }) {
  globalThis.fetch = (async () => new Response(status === 200 ? HTML : "no", { status, headers })) as typeof fetch;
}
function fail(code: string) {
  globalThis.fetch = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code } }); }) as typeof fetch;
}

describe("siteReach", () => {
  it("lets a site that answered through", async () => {
    answer(200);
    expect(await siteReach("paint.example")).toEqual({ ok: true });
  });

  it("lets a refusal through: the run has a way round it", async () => {
    answer(403);
    expect(await siteReach("packhub.io")).toEqual({ ok: true });
    resetHostCircuit();
    answer(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    expect(await siteReach("walled.example")).toEqual({ ok: true });
  });

  it("holds back a host that drops every connection, and says what to do", async () => {
    fail("UND_ERR_SOCKET");
    const r = await siteReach("paint.example");
    expect(r).toMatchObject({ ok: false, why: "UND_ERR_SOCKET" });
    if (r.ok) return;
    expect(r.line).toContain("closed the connection");
    expect(r.line).toContain("AltoRankBot");
    expect(r.line).toContain("nothing is charged");
  });

  it("says a domain with no server is spelled wrong, not blocked", async () => {
    fail("ENOTFOUND");
    const r = await siteReach("paint-shpo.example");
    expect(r).toMatchObject({ ok: false, why: "host not found" });
    if (!r.ok) expect(r.line).toContain("spelled");
  });

  it("holds back a homepage that answers with a server error", async () => {
    answer(503);
    const r = await siteReach("down.example");
    expect(r).toMatchObject({ ok: false, why: "HTTP 503" });
  });
});

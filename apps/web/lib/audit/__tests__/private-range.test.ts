import { describe, it, expect, vi, afterEach } from "vitest";
import { assertPublicUrl, fetchSite, isPrivateHost } from "../lenient-fetch";

/**
 * The free SEO health checker takes a URL from an anonymous form and every
 * crawler fetches what it is handed, from inside the deployment. Until
 * 2026-09-07 nothing refused http://169.254.169.254/ or the local Supabase
 * on 54321, and the body came back in the result.
 */
describe("isPrivateHost", () => {
  it.each([
    "localhost", "LOCALHOST.", "app.localhost", "printer.local", "db.internal",
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255",
    "[::1]", "[::]", "[fe80::1]", "[fc00::1]", "[fd12::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
    "2130706433", "0x7f000001", "017700000001",
  ])("refuses %s", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(["altorank.co", "www.lully.ai", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "[2606:4700::1111]"])(
    "allows %s",
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );
});

describe("assertPublicUrl", () => {
  it("refuses a private address, a local name and a non-http scheme, each in words", () => {
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/private or local address/);
    expect(() => assertPublicUrl("http://localhost:54321/rest/v1/")).toThrow(/private or local address/);
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/Only http and https/);
    expect(() => assertPublicUrl("not a url")).toThrow(/Not a URL/);
  });

  it("lets a public site through", () => {
    expect(() => assertPublicUrl("https://www.lully.ai/")).not.toThrow();
  });

  it("can be lifted for a self-hosted install crawling its own network", () => {
    vi.stubEnv("ALTORANK_ALLOW_PRIVATE_FETCH", "1");
    try {
      expect(() => assertPublicUrl("http://192.168.1.10/")).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("fetchSite", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });

  it("never sends the request when the address is private", async () => {
    const spy = vi.fn(async () => new Response("secret"));
    globalThis.fetch = spy as never;
    await expect(fetchSite("http://127.0.0.1:54321/")).rejects.toThrow(/private or local address/);
    expect(spy).not.toHaveBeenCalled();
  });
});

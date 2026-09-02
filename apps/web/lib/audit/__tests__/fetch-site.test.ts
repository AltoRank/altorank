import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchSite, isTlsChainError } from "../lenient-fetch";

describe("fetchSite", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });

  it("passes a verified response straight through", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>ok</html>", { status: 200 })) as never;
    const res = await fetchSite("https://x.co/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-altorank-tls-unverified")).toBeNull();
  });

  it("rethrows anything that is not a chain error", async () => {
    const err = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    globalThis.fetch = vi.fn(async () => { throw err; }) as never;
    await expect(fetchSite("https://nope.invalid/")).rejects.toBe(err);
    expect(isTlsChainError(err)).toBe(false);
  });
});

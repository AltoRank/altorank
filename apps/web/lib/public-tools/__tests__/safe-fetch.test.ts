import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

vi.mock("node:dns", async (orig) => {
  const real = await orig<typeof import("node:dns")>();
  const table: Record<string, Array<{ address: string; family: number }>> = {
    "public.example.org": [{ address: "93.184.215.14", family: 4 }],
    "rebind.example.org": [{ address: "169.254.169.254", family: 4 }],
    "mixed.example.org": [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ],
    "v6local.example.org": [{ address: "::ffff:127.0.0.1", family: 6 }],
    "loop.example.org": [{ address: "127.0.0.1", family: 4 }],
  };
  return {
    ...real,
    lookup: (host: string, _opts: unknown, cb: (e: Error | null, a?: unknown) => void) => {
      const hit = table[host];
      if (!hit) {
        const e = new Error("ENOTFOUND") as NodeJS.ErrnoException;
        e.code = "ENOTFOUND";
        return cb(e);
      }
      cb(null, hit);
    },
  };
});

import {
  assertFetchableUrl,
  fetchChain,
  guardedLookup,
  isBlockedAddress,
  makeNodeHop,
  UnsafeUrlError,
  FetchFailedError,
  type HopFn,
  type HopResponse,
} from "../safe-fetch";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe",
    "64:ff9b::10.0.0.1", "2001:db8::1", "not-an-ip",
  ])("blocks %s", (a) => expect(isBlockedAddress(a)).toBe(true));

  it.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"])(
    "allows %s",
    (a) => expect(isBlockedAddress(a)).toBe(false),
  );
});

describe("assertFetchableUrl", () => {
  it.each([
    ["http://127.0.0.1/", /private or local/],
    ["http://169.254.169.254/latest/meta-data/", /private or local/],
    ["http://[::1]/", /private or local/],
    ["http://localhost/", /private or local/],
    ["http://2130706433/", /private or local/],
    ["http://0x7f000001/", /private or local/],
    ["ftp://example.org/", /Only http and https/],
    ["file:///etc/passwd", /Only http and https/],
    ["http://user:pw@example.org/", /username or password/],
    ["http://example.org:22/", /Port 22/],
    ["nope", /not a URL/],
  ])("refuses %s", (url, msg) => {
    expect(() => assertFetchableUrl(url)).toThrow(UnsafeUrlError);
    expect(() => assertFetchableUrl(url)).toThrow(msg);
  });

  it("accepts public http(s) on the usual ports", () => {
    expect(assertFetchableUrl("https://example.org/a?b=1").hostname).toBe("example.org");
    expect(assertFetchableUrl("http://example.org:8080/").port).toBe("8080");
  });
});

describe("guardedLookup (the DNS rebinding gate)", () => {
  const run = (host: string, all: boolean) =>
    new Promise<{ err: unknown; addr: unknown }>((resolve) =>
      guardedLookup(host, { all }, (err, addr) => resolve({ err, addr })),
    );

  it("passes a public name through in both callback shapes", async () => {
    expect((await run("public.example.org", false)).addr).toBe("93.184.215.14");
    expect((await run("public.example.org", true)).addr).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("refuses a public name that resolves to the metadata address", async () => {
    const { err } = await run("rebind.example.org", false);
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  it("refuses a name if ANY of its addresses is private", async () => {
    expect((await run("mixed.example.org", true)).err).toBeInstanceOf(UnsafeUrlError);
  });

  it("refuses an IPv4-mapped IPv6 loopback", async () => {
    expect((await run("v6local.example.org", true)).err).toBeInstanceOf(UnsafeUrlError);
  });

  it("passes DNS failures through as they are", async () => {
    const { err } = await run("nx.example.org", false);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("fetchChain (redirect policy)", () => {
  const res = (status: number, headers: Record<string, string> = {}, body = ""): HopResponse => ({
    status,
    headers,
    body: Buffer.from(body),
    truncated: false,
    tlsUnverified: false,
  });

  it("re-validates every hop and never requests a private redirect target", async () => {
    const hop = vi.fn<HopFn>(async () => res(302, { location: "http://127.0.0.1:8080/admin" }));
    await expect(fetchChain("https://example.org/", {}, hop)).rejects.toThrow(UnsafeUrlError);
    expect(hop).toHaveBeenCalledTimes(1);
    expect(hop.mock.calls[0][0].url).toBe("https://example.org/");
  });

  it("refuses a redirect to the metadata service", async () => {
    const hop = vi.fn<HopFn>(async () => res(301, { location: "http://169.254.169.254/latest/meta-data/" }));
    await expect(fetchChain("https://example.org/", {}, hop)).rejects.toThrow(/private or local/);
    expect(hop).toHaveBeenCalledTimes(1);
  });

  it("caps the number of hops", async () => {
    let n = 0;
    const hop: HopFn = async () => res(302, { location: `https://example.org/${++n}` });
    await expect(fetchChain("https://example.org/", { maxRedirects: 3 }, hop)).rejects.toThrow(/more than 3 times/);
  });

  it("detects a loop", async () => {
    const hop: HopFn = async (r) =>
      res(302, { location: r.url.endsWith("/a") ? "https://example.org/b" : "https://example.org/a" });
    await expect(fetchChain("https://example.org/a", {}, hop)).rejects.toThrow(/loop/);
  });

  it("follows relative redirects and records the chain", async () => {
    const hop: HopFn = async (r) =>
      r.url === "http://example.org/" ? res(301, { location: "https://example.org/" }) : res(200, { "content-type": "text/html" }, "<p>hi</p>");
    const out = await fetchChain("http://example.org/", {}, hop);
    expect(out.url).toBe("https://example.org/");
    expect(out.redirects).toEqual([{ url: "http://example.org/", status: 301, location: "https://example.org/" }]);
    expect(out.body).toBe("<p>hi</p>");
  });

  it("returns the 3xx itself when asked not to follow", async () => {
    const hop: HopFn = async () => res(308, { location: "https://example.org/x" });
    const out = await fetchChain("https://example.org/", { followRedirects: false }, hop);
    expect(out.status).toBe(308);
    expect(out.redirects).toEqual([]);
  });

  it("decodes a declared non-UTF-8 charset", async () => {
    const hop: HopFn = async () => ({
      ...res(200, { "content-type": "text/html; charset=iso-8859-1" }),
      body: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    });
    expect((await fetchChain("https://example.org/", {}, hop)).body).toBe("café");
  });
});

describe("the node hop against a real (loopback) server", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(50_000));
      } else if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync("y".repeat(200_000)));
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 2_000);
      } else {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "a=b" });
        res.end("<title>ok</title>");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // The guard is off here only because the test server is on loopback.
  const hop = makeNodeHop(false);
  const req = (path: string, over: Partial<Parameters<HopFn>[0]> = {}) =>
    hop({ url: base + path, method: "GET", headers: {}, maxBytes: 10_000, deadline: Date.now() + 5_000, ...over });

  it("reads a body and drops Set-Cookie", async () => {
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe("<title>ok</title>");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("stops at maxBytes and says so", async () => {
    const r = await req("/big");
    expect(r.body.length).toBe(10_000);
    expect(r.truncated).toBe(true);
  });

  it("caps the DECOMPRESSED size, so a gzip bomb stops at the same place", async () => {
    const r = await req("/gzip");
    expect(r.body.length).toBe(10_000);
    expect(r.truncated).toBe(true);
    expect(r.body.toString().startsWith("yyy")).toBe(true);
  });

  it("times out", async () => {
    await expect(req("/slow", { deadline: Date.now() + 200 })).rejects.toThrow(FetchFailedError);
  });

  it("with the guard ON, a name that resolves to loopback never connects", async () => {
    const guarded = makeNodeHop(true);
    const port = (server.address() as AddressInfo).port;
    await expect(
      guarded({ url: `http://loop.example.org:${port}/`, method: "GET", headers: {}, maxBytes: 1000, deadline: Date.now() + 2000 }),
    ).rejects.toThrow(UnsafeUrlError);
  });
});

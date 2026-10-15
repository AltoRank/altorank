import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { assertSiteUrl, requestOnce, siteFetch } from "../site-fetch";
import { UnsafeUrlError } from "@/lib/public-tools/safe-fetch";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("siteFetch address policy", () => {
  it.each([
    "http://127.0.0.1/wp-json/altorank/v1/test-integration",
    "http://localhost/wp-json/altorank/v1/test-integration",
    "http://10.0.0.5:8080/admin/api?/wp-json/altorank/v1/test-integration",
    "http://169.254.169.254/latest/meta-data?/wp-json/altorank/v1/test-integration",
    "http://[::1]/wp-json/altorank/v1/test-integration",
    "http://intranet.internal/wp-json/altorank/v1/test-integration",
    "https://example.com:22/wp-json/altorank/v1/test-integration",
    "http://user:pass@example.com/wp-json/altorank/v1/test-integration",
    "file:///etc/passwd",
  ])("refuses %s before connecting", async (url) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => assertSiteUrl(url)).toThrow(UnsafeUrlError);
    await expect(siteFetch(url, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says how a self-hosted install reaches its own network", async () => {
    const err = await siteFetch("http://192.168.1.10/").catch((e: Error) => e);
    expect((err as Error).message).toContain("ALTORANK_ALLOW_PRIVATE_FETCH=1");
    expect((err as Error).message).not.toContain("can be checked");
  });

  it("ALTORANK_ALLOW_PRIVATE_FETCH=1 lets a private address through, still without following redirects", async () => {
    vi.stubEnv("ALTORANK_ALLOW_PRIVATE_FETCH", "1");
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(() => assertSiteUrl("http://192.168.1.10/")).not.toThrow();
    const res = await siteFetch("http://192.168.1.10/wp-json/altorank/v1/submit", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}", redirect: "manual" });
  });
});

describe("requestOnce (loopback server, guard off)", () => {
  let server: Server;
  let base: string;
  const seen: Array<{ method?: string; headers: Record<string, unknown>; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, headers: req.headers, body });
        if (req.url === "/redirect") {
          res.writeHead(302, { location: "http://169.254.169.254/" });
          return res.end();
        }
        if (req.url === "/gzip") {
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          return res.end(gzipSync(JSON.stringify({ ok: true })));
        }
        if (req.url === "/big") {
          res.writeHead(200, { "content-type": "text/plain" });
          return res.end("x".repeat(5000));
        }
        if (req.url === "/slow") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{");
          return; // never ends
        }
        if (req.url === "/expands") {
          res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
          return res.end(gzipSync(Buffer.alloc(2_000_000)));
        }
        if (req.url === "/expands-br") {
          res.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
          return res.end(brotliCompressSync(Buffer.alloc(2_000_000)));
        }
        if (req.url === "/empty") {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(201, { "content-type": "application/json", "set-cookie": "a=b" });
        res.end(JSON.stringify({ id: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends the method, headers and body, and returns a standard Response", async () => {
    const res = await requestOnce(
      new URL(`${base}/wp-json/altorank/v1/submit`),
      { method: "POST", headers: { "X-AltoRank-Token": "t", "Content-Type": "application/json" }, body: '{"a":"é"}' },
      5000,
      false,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1 });
    expect(res.headers.get("set-cookie")).toBeNull();
    const last = seen[seen.length - 1];
    expect(last.method).toBe("POST");
    expect(last.headers["x-altorank-token"]).toBe("t");
    expect(last.body).toBe('{"a":"é"}');
    expect(last.headers["content-length"]).toBe(String(Buffer.byteLength('{"a":"é"}')));
  });

  it("does not follow a redirect", async () => {
    const res = await requestOnce(new URL(`${base}/redirect`), {}, 5000, false);
    expect(res.status).toBe(302);
    expect(seen[seen.length - 1].headers.host).toContain("127.0.0.1");
  });

  it("decodes a compressed body and handles an empty one", async () => {
    expect(await (await requestOnce(new URL(`${base}/gzip`), {}, 5000, false)).json()).toEqual({ ok: true });
    const empty = await requestOnce(new URL(`${base}/empty`), {}, 5000, false);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("the deadline covers a body that starts and never finishes", async () => {
    const started = Date.now();
    await expect(requestOnce(new URL(`${base}/slow`), {}, 300, false)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each(["/expands", "/expands-br"])("the size cap applies to the decoded body too (%s)", async (p) => {
    await expect(requestOnce(new URL(`${base}${p}`), { maxBytes: 100_000 }, 5000, false)).rejects.toThrow(/larger than 100000 bytes/);
  });

  it("stops reading past the size cap", async () => {
    await expect(requestOnce(new URL(`${base}/big`), { maxBytes: 100 }, 5000, false)).rejects.toThrow(/larger than 100 bytes/);
  });
});

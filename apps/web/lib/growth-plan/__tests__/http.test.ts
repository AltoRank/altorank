// A credentialed CORS answer must name the exact origin and add
// Access-Control-Allow-Credentials, and only for altorank.co itself.

import { describe, it, expect, afterEach, vi } from "vitest";
import { allowsCredentials, corsHeaders, json, preflight } from "../http";

afterEach(() => vi.unstubAllEnvs());

describe("credentialed CORS", () => {
  it.each(["https://altorank.co", "https://www.altorank.co"])("echoes %s with credentials", (origin) => {
    const h = corsHeaders(origin, { credentials: true });
    expect(h["Access-Control-Allow-Origin"]).toBe(origin);
    expect(h["Access-Control-Allow-Credentials"]).toBe("true");
    expect(h.Vary).toBe("Origin");
  });

  it.each(["https://evil.com", "https://app.altorank.co", "null", "https://altorank.co.evil.com"])(
    "never grants credentials to %s",
    (origin) => {
      const h = corsHeaders(origin, { credentials: true });
      expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
      expect(h["Access-Control-Allow-Origin"]).not.toBe(origin);
    },
  );

  it("never grants credentials to a missing origin, and never answers a wildcard", () => {
    const h = corsHeaders(null, { credentials: true });
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
    expect(h["Access-Control-Allow-Origin"]).not.toBe("*");
  });

  it("grants the local Astro origins outside production only", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(allowsCredentials("http://localhost:4321")).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(allowsCredentials("http://localhost:4321")).toBe(false);
    expect(allowsCredentials("https://altorank.co")).toBe(true);
    const h = corsHeaders("http://localhost:4321", { credentials: true });
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
    // Still answered without credentials, as before.
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:4321");
  });

  it("leaves the anonymous routes exactly as they were", () => {
    const h = corsHeaders("https://altorank.co");
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
    expect(h["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
  });

  it("carries the headers on the preflight and on the answer", async () => {
    const pre = preflight("https://altorank.co", { credentials: true, methods: "GET, OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://altorank.co");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    const res = json({ ok: true }, 200, "https://www.altorank.co", { "Retry-After": "5" }, { credentials: true });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.altorank.co");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("retry-after")).toBe("5");
  });
});

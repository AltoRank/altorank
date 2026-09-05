import { describe, it, expect } from "vitest";
import { parsePublicDomain, DOMAIN_ERROR } from "../domain";

const ok = (raw: string) => {
  const r = parsePublicDomain(raw);
  return r.ok ? r.domain : `ERR:${r.error}`;
};

describe("parsePublicDomain", () => {
  it("accepts a bare domain unchanged", () => {
    expect(ok("example.com")).toBe("example.com");
  });

  it("strips scheme, www, path, query, hash and trailing slash", () => {
    expect(ok("https://www.Example.com/pricing?x=1#top")).toBe("example.com");
    expect(ok("http://example.com/")).toBe("example.com");
  });

  it("strips a port, userinfo and a trailing dot", () => {
    expect(ok("https://user:pw@example.com:8443/")).toBe("example.com");
    expect(ok("example.com.")).toBe("example.com");
  });

  it("keeps subdomains other than www", () => {
    expect(ok("blog.example.co.uk")).toBe("blog.example.co.uk");
  });

  it("trims whitespace and lowercases", () => {
    expect(ok("  LIMINEER.COM  ")).toBe("example.com");
  });

  it("rejects things that are not a public hostname", () => {
    for (const bad of ["", "   ", "example", "localhost", "127.0.0.1", "10.0.0.1", "-bad.com", "bad-.com", "a b.com", "http://", 42 as unknown as string]) {
      const r = parsePublicDomain(bad);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(parsePublicDomain("example")).toEqual({ ok: false, error: DOMAIN_ERROR });
  });

  it("refuses reserved and private top-level labels before any fetch", () => {
    for (const bad of ["intranet.local", "db.internal", "printer.lan", "site.test", "foo.example", "x.onion"]) {
      const r = parsePublicDomain(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/not a public site/);
    }
  });

  it("enforces label and total length caps", () => {
    expect(parsePublicDomain(`${"a".repeat(64)}.com`).ok).toBe(false);
    expect(parsePublicDomain(`${"a".repeat(63)}.com`).ok).toBe(true);
    const long = Array.from({ length: 5 }, () => "a".repeat(60)).join(".") + ".com";
    expect(parsePublicDomain(long).ok).toBe(false);
  });
});

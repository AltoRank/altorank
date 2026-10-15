import { describe, it, expect } from "vitest";
import { matchGSCSite } from "../gsc";

const site = (siteUrl: string, permissionLevel = "siteOwner") => ({ siteUrl, permissionLevel });

describe("matchGSCSite", () => {
  it("prefers the domain property, then https, then www", () => {
    expect(matchGSCSite([site("https://altorank.co/"), site("sc-domain:altorank.co")], "www.altorank.co")!.siteUrl).toBe("sc-domain:altorank.co");
    expect(matchGSCSite([site("https://www.acme.com/"), site("https://acme.com/")], "acme.com")!.siteUrl).toBe("https://acme.com/");
  });
  it("ignores properties the account can only read metadata for", () => {
    expect(matchGSCSite([site("sc-domain:acme.com", "siteUnverifiedUser")], "acme.com")).toBeNull();
  });
  it("returns null when the account owns nothing for the domain", () => {
    expect(matchGSCSite([site("sc-domain:other.com")], "acme.com")).toBeNull();
  });
});

describe("gscPropertyCovers", () => {
  it("accepts the site's own host, its www form, a subdomain and a covering domain property", async () => {
    const { gscPropertyCovers } = await import("../gsc");
    expect(gscPropertyCovers("sc-domain:acme.com", "acme.com")).toBe(true);
    expect(gscPropertyCovers("sc-domain:acme.com", "www.acme.com")).toBe(true);
    expect(gscPropertyCovers("sc-domain:acme.com", "blog.acme.com")).toBe(true);
    expect(gscPropertyCovers("https://www.acme.com/", "acme.com")).toBe(true);
    expect(gscPropertyCovers("http://acme.com/", "https://acme.com/blog")).toBe(true);
    expect(gscPropertyCovers("https://blog.acme.com/", "acme.com")).toBe(true);
  });
  it("refuses another site's property, including look-alike hosts", async () => {
    const { gscPropertyCovers } = await import("../gsc");
    expect(gscPropertyCovers("sc-domain:client-b.example", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://client-b.example/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://acme.com.evil.example/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://notacme.com/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("sc-domain:", "acme.com")).toBe(false);
    expect(gscPropertyCovers("acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("sc-domain:acme.com", "")).toBe(false);
  });
  it("reads only a plain hostname out of a stored property", async () => {
    const { gscPropertyCovers } = await import("../gsc");
    expect(gscPropertyCovers("https://client-b.example/?.acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://client-b.example#.acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://client-b.example\\.acme.com/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://acme.com@client-b.example/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://client-b.example:443/", "acme.com")).toBe(false);
    expect(gscPropertyCovers("sc-domain:client-b.example/.acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("sc-domain:client-b.example .acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("javascript:acme.com", "acme.com")).toBe(false);
    expect(gscPropertyCovers("https://acme.com:8443/blog/", "acme.com")).toBe(true);
    expect(gscPropertyCovers("HTTPS://WWW.ACME.COM/", "acme.com")).toBe(true);
  });
  it("matchGSCSite's subdomain fallback no longer takes a host that merely contains the domain", () => {
    expect(matchGSCSite([site("https://notacme.com/")], "acme.com")).toBeNull();
    expect(matchGSCSite([site("https://blog.acme.com/")], "acme.com")!.siteUrl).toBe("https://blog.acme.com/");
  });
});

import { describe, expect, it, vi } from "vitest";
import { hostKind, landedAway, notOwnSiteMessage, resolveOwnSite } from "../own-site";

const redirectTo = (location: string | null, status = 302) => new Response(null, { status, headers: location ? { location } : {} });

describe("hostKind", () => {
  it("names a share link, a profile, a link page and a listing, and lets a site through", () => {
    for (const host of ["share.google", "bit.ly", "www.tinyurl.com", "g.co"]) expect(hostKind(host), host).toBe("shortener");
    for (const host of ["facebook.com", "m.facebook.com", "www.instagram.com", "linkedin.com"]) expect(hostKind(host), host).toBe("social");
    expect(hostKind("linktr.ee")).toBe("link_page");
    for (const host of ["etsy.com", "www.amazon.co.uk", "ebay.de", "google.com", "maps.app.goo.gl"]) expect(hostKind(host), host).toBe("marketplace");
    // A site on a platform's own subdomain is a site, and so is a name that only contains a listed one.
    for (const host of ["acme.com", "acme.myshopify.com", "acme.wordpress.com", "notfacebook.com", "getsy.com", "amazonia-tours.example"]) expect(hostKind(host), host).toBeNull();
  });
});

describe("resolveOwnSite", () => {
  it("hands a plain domain back normalised, and fetches nothing for it", async () => {
    const fetch = vi.fn();
    expect(await resolveOwnSite("https://www.Acme.com/pricing?x=1", { fetch })).toEqual({ ok: true, domain: "acme.com" });
    expect(await resolveOwnSite("not a domain", { fetch })).toEqual({ ok: true, domain: "not a domain" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows a share link to the business's own site", async () => {
    const fetch = vi.fn(async () => redirectTo("https://www.gardenrooms.example/about?utm=share"));
    expect(await resolveOwnSite("https://share.google/AbC123", { fetch })).toEqual({ ok: true, domain: "gardenrooms.example", via: "share.google" });
    // The whole link is requested, path and all, and its redirect is read, not followed.
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://share.google/AbC123");
    expect(init.redirect).toBe("manual");
  });

  it("follows one shortener into another, and only ever requests a shortener", async () => {
    const fetch = vi.fn(async (url: string) => (url.startsWith("https://bit.ly") ? redirectTo("https://tinyurl.com/xyz") : redirectTo("https://acme.example/")));
    expect(await resolveOwnSite("bit.ly/abc", { fetch })).toEqual({ ok: true, domain: "acme.example", via: "bit.ly" });
    expect(fetch.mock.calls.map(([u]) => new URL(u as string).hostname)).toEqual(["bit.ly", "tinyurl.com"]);
  });

  it("refuses a share link that leads to a profile, to nothing, or round in circles", async () => {
    const toProfile = await resolveOwnSite("https://share.google/x", { fetch: async () => redirectTo("https://www.facebook.com/gardenrooms") });
    expect(toProfile).toMatchObject({ ok: false, kind: "social" });
    const nowhere = await resolveOwnSite("https://share.google/x", { fetch: async () => new Response("<html>", { status: 200 }) });
    expect(nowhere).toEqual({ ok: false, kind: "shortener", reason: notOwnSiteMessage("shortener") });
    const failed = await resolveOwnSite("https://share.google/x", { fetch: async () => { throw new Error("timeout"); } });
    expect(failed).toMatchObject({ ok: false, kind: "shortener" });
    const loop = vi.fn(async () => redirectTo("https://bit.ly/again"));
    expect(await resolveOwnSite("bit.ly/again", { fetch: loop })).toMatchObject({ ok: false, kind: "shortener" });
    expect(loop).toHaveBeenCalledTimes(5);
    // Never a scheme a browser would not open.
    expect(await resolveOwnSite("bit.ly/x", { fetch: async () => redirectTo("file:///etc/passwd") })).toMatchObject({ ok: false });
  });

  it("refuses a profile, a link page and a listing without fetching, and asks for the business's own site", async () => {
    const fetch = vi.fn();
    const profile = await resolveOwnSite("https://www.instagram.com/gardenrooms/", { fetch });
    expect(profile).toMatchObject({ ok: false, kind: "social" });
    expect(profile.ok === false && profile.reason).toMatch(/not your website\. Enter your business's own site, like acme\.com/);
    expect(await resolveOwnSite("linktr.ee/gardenrooms", { fetch })).toMatchObject({ ok: false, kind: "link_page" });
    expect(await resolveOwnSite("https://www.etsy.com/shop/gardenrooms", { fetch })).toMatchObject({ ok: false, kind: "marketplace" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("landedAway", () => {
  it("refuses a domain that only forwards to a profile, and passes one that lands on a site", () => {
    expect(landedAway("facebook.com")).toMatchObject({ ok: false, kind: "social" });
    expect(landedAway("shop.acme.example")).toBeNull();
    expect(landedAway(undefined)).toBeNull();
  });
});

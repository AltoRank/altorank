import { describe, it, expect } from "vitest";
import { checkSiteUrl, verifyObservedFacts, verifyObservedUrl } from "../observed-facts";
import { observedFrom } from "../site-text";
import { linksForPrompt, parseProfile, type BusinessProfile } from "../business-profile";
import { fakeFetch } from "@/lib/public-tools/__tests__/fake-fetch";
import { FetchFailedError } from "@/lib/public-tools/safe-fetch";

// A real signup, 2026-09-22 (Turkish web/mobile agency), had `/iletisim`
// stored as the "observed" conversion page. It was a 404: the model had been
// shown tag-stripped text, so any URL it named was built from a word. An
// observed URL is now a page the read fetched with a 2xx, or a link on one
// that answers 2xx; anything else is stored as null with the reason.

const DOMAIN = "ornek-ajans.example";
const HOME = `https://${DOMAIN}/`;
const NOW = new Date("2026-09-25T10:00:00Z");

const observed = observedFrom(DOMAIN, [
  {
    url: HOME,
    html: `<html><body>
      <nav><a href="/hizmetler">Hizmetler</a> <a href="/bize-ulasin">Bize Ulaşın</a> <a href="/teklif-al">Teklif Al</a>
      <a href="/eski-iletisim">Eski</a> <a href="/tasindi">Taşındı</a> <a href="/disari">Randevu</a> <a href="/yavas">Yavaş</a></nav>
      <a href="https://www.instagram.com/ornek">Instagram</a> <a href="mailto:info@ornek-ajans.example">E-posta</a>
    </body></html>`,
  },
  { url: `https://${DOMAIN}/hakkimizda`, html: "<html><body><h1>Hakkımızda</h1></body></html>" },
]);

const fetch = fakeFetch({
  [`https://${DOMAIN}/bize-ulasin`]: { status: 200, body: "<html>form</html>" },
  [`https://${DOMAIN}/teklif-al`]: { status: 200, finalUrl: `https://${DOMAIN}/teklif-al/` },
  [`https://${DOMAIN}/eski-iletisim`]: { status: 404 },
  [`https://${DOMAIN}/tasindi`]: { status: 200, finalUrl: HOME },
  [`https://${DOMAIN}/disari`]: { status: 200, finalUrl: "https://calendar.example/ornek" },
  [`https://${DOMAIN}/yavas`]: { status: 429 },
});

describe("observedFrom", () => {
  it("keeps the pages that answered and the same-site links on them, not mail or other sites", () => {
    expect(observed.pages).toEqual([HOME, `https://${DOMAIN}/hakkimizda`]);
    expect(observed.links.map((l) => l.url)).toContain(`https://${DOMAIN}/bize-ulasin`);
    expect(observed.links.find((l) => l.url.endsWith("/bize-ulasin"))?.text).toBe("Bize Ulaşın");
    expect(observed.links.some((l) => l.url.includes("instagram") || l.url.startsWith("mailto"))).toBe(false);
  });
});

describe("verifyObservedUrl", () => {
  const verify = (proposed: string | null) => verifyObservedUrl(proposed, DOMAIN, observed, { fetch, now: NOW });

  it("keeps a linked page that answers 200", async () => {
    const out = await verify("/bize-ulasin");
    expect(out.url).toBe(`https://${DOMAIN}/bize-ulasin`);
    expect(out.check).toEqual({
      proposed: "/bize-ulasin",
      verified: true,
      reason: "Linked from a page on the site, and it answered HTTP 200.",
      checkedAt: "2026-09-25T10:00:00.000Z",
    });
  });

  it("stores where a same-site redirect ends", async () => {
    expect((await verify(`https://${DOMAIN}/teklif-al`)).url).toBe(`https://${DOMAIN}/teklif-al/`);
  });

  it("refuses a 404 and says so", async () => {
    const out = await verify("/eski-iletisim");
    expect(out.url).toBeNull();
    expect(out.check.verified).toBe(false);
    expect(out.check.reason).toBe("/eski-iletisim was proposed, but it answered HTTP 404, page gone. Not stored.");
  });

  it("refuses a page that redirects to the homepage, and one that redirects off the site", async () => {
    expect((await verify("/tasindi")).check.reason).toMatch(/redirects to the homepage/);
    expect((await verify("/tasindi")).url).toBeNull();
    expect((await verify("/disari")).check.reason).toMatch(/redirects off the site, to calendar\.example/);
  });

  it("refuses a guessed path without opening it", async () => {
    fetch.mockClear();
    const out = await verify("/iletisim");
    expect(out.url).toBeNull();
    expect(out.check.reason).toBe("/iletisim was proposed, but it is not a page we read or a link on one, so it was a guess. Not stored.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes a page the read itself fetched as checked, without asking again", async () => {
    fetch.mockClear();
    const out = await verify(`https://www.${DOMAIN}/hakkimizda/`);
    expect(out.url).toBe(`https://${DOMAIN}/hakkimizda`);
    expect(out.check.verified).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not store a page the site would not let us check, and says it could not", async () => {
    const out = await verify("/yavas");
    expect(out.url).toBeNull();
    expect(out.check.reason).toMatch(/did not let us check it \(HTTP 429, could not verify\)/);
  });

  it("refuses another site's URL and an empty proposal, with reasons", async () => {
    expect((await verify("https://www.instagram.com/ornek")).check.reason).toMatch(/not a page on ornek-ajans\.example/);
    expect((await verify(null)).check.reason).toMatch(/No product, pricing, booking or contact page/);
  });
});

describe("checkSiteUrl", () => {
  it("calls a name that does not resolve dead and a timeout unverified", async () => {
    const dns = fakeFetch(() => Object.assign(new FetchFailedError("the domain does not resolve", HOME), { cause: { code: "ENOTFOUND" } }));
    expect((await checkSiteUrl(`https://${DOMAIN}/x`, DOMAIN, { fetch: dns })).state).toBe("dead");
    const slow = fakeFetch(() => new FetchFailedError("timed out", HOME));
    expect(await checkSiteUrl(`https://${DOMAIN}/x`, DOMAIN, { fetch: slow })).toMatchObject({ state: "unverified", reason: "timed out" });
  });
});

describe("verifyObservedFacts", () => {
  it("replaces a guessed conversion page with null and keeps the reason on the profile", async () => {
    const profile: BusinessProfile = {
      name: "Örnek Ajans", language: "Turkish", country: "Turkey", description: "Mobil uygulama ajansı.",
      audiences: [], competitors: [], conversionUrl: "/iletisim",
    };
    const out = await verifyObservedFacts(profile, DOMAIN, observed, { fetch, now: NOW });
    expect(out.conversionUrl).toBeNull();
    expect(out.observedChecks?.conversionUrl).toMatchObject({ proposed: "/iletisim", verified: false });
    expect(out.name).toBe("Örnek Ajans");
  });
});

describe("the profile prompt", () => {
  it("shows the model the links it may choose from, and says so when there are none", () => {
    expect(linksForPrompt(observed)).toContain(`- Bize Ulaşın: https://${DOMAIN}/bize-ulasin`);
    expect(linksForPrompt(undefined)).toBe('LINKS ON THE PAGES READ: none were found, so conversionUrl must be "".');
  });

  it("parses an empty conversion page as null, not as an empty string", () => {
    const p = parseProfile('{"name":"A","conversionUrl":""}', DOMAIN);
    expect(p?.conversionUrl).toBeNull();
    expect(parseProfile('{"name":"A","conversionUrl":" /bize-ulasin "}', DOMAIN)?.conversionUrl).toBe("/bize-ulasin");
  });
});

describe("a one-page site", () => {
  it("keeps the section a contact link points at, on a page the read fetched", async () => {
    const onePage = observedFrom(DOMAIN, [{ url: HOME, html: `<nav><a href="/#iletisim">İletişim</a></nav>` }]);
    const out = await verifyObservedUrl("/#iletisim", DOMAIN, onePage, { fetch: fakeFetch({}), now: NOW });
    expect(out.url).toBe(`${HOME}#iletisim`);
    expect(out.check.verified).toBe(true);
  });
});

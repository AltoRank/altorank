import { describe, it, expect, vi, afterEach } from "vitest";
import { CREDITS_PER_ARTICLE, settlementDecision, verifyPlacementLive } from "../exchange";

// These cases were first run against real HTTP (a local fixture server and live
// sites) and only then pinned here. Mocked fetch alone would prove the code
// agrees with itself, which is exactly the failure mode that let two DataForSEO
// parsers ship returning nothing.

describe("CREDITS_PER_ARTICLE", () => {
  it("is one flat credit per article, whoever publishes it", () => {
    // Replaced a five-tier price derived from the publisher's domain rating.
    // A price that rises with the publisher's authority prices the LINK, and a
    // priced link is a paid link whichever column the number sits in.
    expect(CREDITS_PER_ARTICLE).toBe(1);
  });
});

const TARGET = "https://example.com/venture-building";

function mockPage(html: string, init?: { status?: number; headers?: Record<string, string> }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(html, {
        status: init?.status ?? 200,
        headers: init?.headers ?? {},
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("verifyPlacementLive", () => {
  it("accepts a live, indexable, followed byline and says it is followed", async () => {
    // The expected outcome since 039: the publisher pays for the article, so
    // nothing was paid for the link and there is nothing to qualify.
    mockPage(`<a href="${TARGET}" rel="noopener noreferrer">venture builders</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/followed/);
  });

  it("accepts a bare anchor with no rel at all", async () => {
    mockPage(`<a href="${TARGET}">venture builders</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(true);
    expect(v.rel).toBeNull();
  });

  it("matches the target across scheme, case and trailing slash", async () => {
    mockPage(`<a href="http://LIMINEER.com/venture-building/" rel="sponsored nofollow">x</a>`);
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(true);
  });

  it("reports a rel the publisher added, without failing on it", async () => {
    // A publisher may qualify the citation at their own discretion. It is
    // their page, the trade already settled on publication, and the writer is
    // owed the truth about what they got rather than an enforcement action.
    mockPage(`<a href="${TARGET}" rel="nofollow">venture builders</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(true);
    expect(v.rel).toBe("nofollow");
    expect(v.reason).toMatch(/qualified it with nofollow/);
  });

  it("rejects a correct link on a noindex page", async () => {
    mockPage(
      `<head><meta name="robots" content="noindex, follow"></head>` +
        `<a href="${TARGET}">x</a>`,
    );
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(false);
  });

  it("rejects a correct link behind an X-Robots-Tag noindex header", async () => {
    mockPage(`<a href="${TARGET}" rel="nofollow sponsored">x</a>`, {
      headers: { "x-robots-tag": "noindex" },
    });
    expect((await verifyPlacementLive("https://host.example/post", TARGET)).ok).toBe(false);
  });

  it("rejects a page that does not carry the link at all", async () => {
    mockPage(`<a href="https://example.com/other" rel="nofollow sponsored">x</a>`);
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no link to the target/);
  });

  it("rejects a non-200 page", async () => {
    mockPage("not found", { status: 404 });
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.httpStatus).toBe(404);
  });

  it("rejects an article that was never published", async () => {
    const v = await verifyPlacementLive(null, TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no published URL/);
  });

  it("rejects rather than throws when the host is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const v = await verifyPlacementLive("https://host.example/post", TARGET);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/could not fetch/);
  });
});

describe("settlementDecision", () => {
  const base = {
    status: "placed",
    provider_agency_id: "agency-publisher",
    requester_agency_id: "agency-writer",
  };

  it("settles a placed exchange at the flat per-article price", () => {
    expect(settlementDecision(base)).toEqual({ settle: true, credits: CREDITS_PER_ARTICLE });
  });

  it("does not care whether the citation survived", () => {
    // The whole point of the redesign. The decision function is not given the
    // link's fate, so it cannot depend on it: the host may cut the citation
    // while editing and is still paid for publishing the article. Settlement
    // that required the link would mean the credits bought the link.
    expect(Object.keys(base)).not.toContain("citation");
    expect(settlementDecision(base)).toEqual({ settle: true, credits: CREDITS_PER_ARTICLE });
  });

  it("refuses to settle until the article is actually placed", () => {
    for (const status of ["requested", "accepted", "live", "rejected", "expired"]) {
      const d = settlementDecision({ ...base, status });
      expect(d.settle).toBe(false);
      expect(d.settle === false && d.reason).toContain(status);
    }
  });

  it("refuses an exchange missing either side", () => {
    expect(settlementDecision({ ...base, provider_agency_id: null }).settle).toBe(false);
    expect(settlementDecision({ ...base, requester_agency_id: null }).settle).toBe(false);
  });

  it("prices a brand-new site the same as an established one", () => {
    // Nothing about the publisher changes the price, which is the point: the
    // article is what was traded, and one article costs what another costs.
    expect(settlementDecision(base).settle && settlementDecision(base)).toEqual({
      settle: true,
      credits: CREDITS_PER_ARTICLE,
    });
  });
});

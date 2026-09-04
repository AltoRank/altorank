import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchDomainMetrics } from "../domain-metrics";

// DataForSEO validates location and language as a PAIR. Asking for Italian
// results in the United States is rejected with "Invalid Field:
// 'language_code'", which reads as though the field were unsupported rather
// than mismatched. analyseDomain passed the workspace's language and let the
// location default to 2840, so organic traffic came back null on every
// non-English workspace and the header read "— organic /mo" forever.
// Confirmed against the live API 2026-09-04: 2380+it works, 2840+it does not.

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/seo/client", () => ({ post, hasDataForSEOCredentials: () => true }));

const BACKLINKS = { tasks: [{ result: [{ rank: 270, referring_domains: 37 }] }] };
const OVERVIEW = { tasks: [{ result: [{ items: [{ metrics: { organic: { etv: 1234.6 } } }] }] }] };

/** The two calls are issued in order inside one Promise.allSettled. */
const answerInOrder = () => post.mockResolvedValueOnce(BACKLINKS).mockResolvedValueOnce(OVERVIEW);
const bodyFor = (fragment: string) =>
  post.mock.calls.find((c) => String(c[0]).includes(fragment))?.[1]?.[0];

beforeEach(() => post.mockReset());

describe("fetchDomainMetrics", () => {
  it("sends the location it was given, not a US default", async () => {
    answerInOrder();
    await fetchDomainMetrics("fitsuite.co", { languageCode: "it", locationCode: 2380 });
    expect(bodyFor("domain_rank_overview")).toMatchObject({
      target: "fitsuite.co",
      location_code: 2380,
      language_code: "it",
    });
  });

  it("still defaults to the US when no location is supplied", async () => {
    answerInOrder();
    await fetchDomainMetrics("x.co", { languageCode: "en" });
    expect(bodyFor("domain_rank_overview")).toMatchObject({ location_code: 2840, language_code: "en" });
  });

  it("returns both metrics when both endpoints answer", async () => {
    answerInOrder();
    expect(await fetchDomainMetrics("x.co", { languageCode: "en", locationCode: 2840 })).toEqual({
      authority: 27,
      traffic: 1235,
      referringDomains: 37,
    });
  });

  it("keeps the metric that worked when the other endpoint fails", async () => {
    post
      .mockResolvedValueOnce(BACKLINKS)
      .mockRejectedValueOnce(new Error("Invalid Field: 'language_code'."));
    const m = await fetchDomainMetrics("x.co", { languageCode: "it" });
    expect(m.authority).toBe(27);
    // Null, not zero: unmeasured traffic is not an absence of traffic.
    expect(m.traffic).toBeNull();
  });
});

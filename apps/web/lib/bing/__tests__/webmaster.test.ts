import { describe, expect, it } from "vitest";
import { matchBingSite, parseBingDate, unwrap } from "../webmaster";
import { rowsFromBingDaily, sinceDate } from "../sync";

describe("parseBingDate", () => {
  it("reads the WCF millisecond form Microsoft documents, offset and all", () => {
    // Microsoft's own sample: 2011-09-16 Pacific midnight.
    expect(parseBingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(parseBingDate("/Date(1316156400000)/")).toBe("2011-09-16");
  });
  it("accepts the ISO form the XML flavour uses", () => {
    expect(parseBingDate("2011-09-16T00:00:00-07:00")).toBe("2011-09-16");
  });
  it("returns null for anything else rather than inventing a day", () => {
    expect(parseBingDate(undefined)).toBeNull();
    expect(parseBingDate("/Date(abc)/")).toBeNull();
    expect(parseBingDate("not a date")).toBeNull();
  });
});

describe("unwrap", () => {
  it("takes the d array, or a bare array, or nothing", () => {
    expect(unwrap({ d: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(unwrap([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(unwrap({ error: "x" })).toEqual([]);
    expect(unwrap(null)).toEqual([]);
  });
});

const site = (url: string, isVerified = true) => ({ url, isVerified });

describe("matchBingSite", () => {
  it("matches the domain across scheme and www, and never an unverified site", () => {
    expect(matchBingSite([site("http://example.com")], "www.example.com")!.url).toBe("http://example.com");
    expect(matchBingSite([site("https://www.lully.ai/")], "lully.ai")!.url).toBe("https://www.lully.ai/");
    expect(matchBingSite([site("https://example.com", false)], "example.com")).toBeNull();
  });
  it("prefers the exact host over a subdomain, and takes a subdomain over nothing", () => {
    expect(matchBingSite([site("https://blog.example.com"), site("https://example.com")], "example.com")!.url).toBe("https://example.com");
    expect(matchBingSite([site("https://blog.example.com")], "example.com")!.url).toBe("https://blog.example.com");
  });
  it("does not match a different domain that merely contains the name", () => {
    expect(matchBingSite([site("https://notexample.com")], "example.com")).toBeNull();
    expect(matchBingSite([site("https://example.com.evil.net")], "example.com")).toBeNull();
  });
});

describe("rowsFromBingDaily", () => {
  it("keeps the window, one row per day, with ctr derived and never divided by zero", () => {
    const rows = rowsFromBingDaily(
      "ws1",
      [
        { date: "2026-06-01", clicks: 5, impressions: 100 },
        { date: "2026-09-01", clicks: 3, impressions: 60 },
        { date: "2026-09-02", clicks: 0, impressions: 0 },
      ],
      "2026-08-01",
    );
    expect(rows.map((r) => r.metric_date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(rows[0]).toMatchObject({ workspace_id: "ws1", source: "bing", clicks: 3, impressions: 60, ctr: 0.05 });
    expect(rows[1].ctr).toBe(0);
    expect(rows.every((r) => !("query" in r) && !("page_url" in r))).toBe(true);
  });
});

describe("sinceDate", () => {
  it("counts back in UTC days", () => {
    expect(sinceDate(7, new Date("2026-09-02T10:00:00Z"))).toBe("2026-08-26");
    expect(sinceDate(60, new Date("2026-09-02T10:00:00Z"))).toBe("2026-07-04");
  });
});

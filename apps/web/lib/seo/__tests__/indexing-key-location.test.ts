import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { indexNowKeyLocation, submitForIndexing } from "../indexing";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 202 }));
});

describe("indexNowKeyLocation", () => {
  it("defaults to the host root", () => {
    expect(indexNowKeyLocation("example.com", "k1234567")).toBe("https://example.com/k1234567.txt");
  });

  it("uses the location the destination reported, subdirectory and scheme included", () => {
    expect(indexNowKeyLocation("example.com", "k1234567", "http://example.com/blog/k1234567.txt")).toBe(
      "http://example.com/blog/k1234567.txt",
    );
  });

  it("falls back to the root for a location on another host, for another key, or not a URL", () => {
    const root = "https://example.com/k1234567.txt";
    expect(indexNowKeyLocation("example.com", "k1234567", "https://elsewhere.example/k1234567.txt")).toBe(root);
    expect(indexNowKeyLocation("example.com", "k1234567", "https://example.com/blog/other.txt")).toBe(root);
    expect(indexNowKeyLocation("example.com", "k1234567", "https://example.com/k1234567.txt?x=1")).toBe(root);
    expect(indexNowKeyLocation("example.com", "k1234567", "ftp://example.com/k1234567.txt")).toBe(root);
    expect(indexNowKeyLocation("example.com", "k1234567", "not a url")).toBe(root);
  });
});

describe("submitForIndexing", () => {
  it("submits with the reported key location", async () => {
    const result = await submitForIndexing({
      url: "https://example.com/blog/post",
      indexNowKey: "k1234567",
      gscToken: null,
      keyLocation: "https://example.com/blog/k1234567.txt",
    });
    expect(result.indexnow).toBe("submitted");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ host: "example.com", key: "k1234567", keyLocation: "https://example.com/blog/k1234567.txt" });
  });

  it("submits with the root location when none was reported", async () => {
    await submitForIndexing({ url: "https://example.com/post", indexNowKey: "k1234567", gscToken: null });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).keyLocation).toBe("https://example.com/k1234567.txt");
  });
});

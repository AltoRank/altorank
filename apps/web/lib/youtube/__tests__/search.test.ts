import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchYouTubeVideos, resolveYouTubeChannelId } from "../search";

// The channel restriction is the whole point: "only my channel" set and then
// ignored would embed a competitor's video under the owner's name.

const fetchMock = vi.fn();
const ITEM = { id: { videoId: "v1" }, snippet: { title: "T", channelTitle: "C", thumbnails: { medium: { url: "" } } } };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.YOUTUBE_API_KEY = "k";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.YOUTUBE_API_KEY;
});

function url(call: number): URL {
  return new URL(String(fetchMock.mock.calls[call][0]));
}

describe("searchYouTubeVideos", () => {
  it("searches all of YouTube when no channel is set", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [ITEM] }) });
    const r = await searchYouTubeVideos("how to", 1);
    expect(r).toHaveLength(1);
    expect(url(0).searchParams.has("channelId")).toBe(false);
  });

  it("passes a channel id straight through as channelId", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [ITEM] }) });
    await searchYouTubeVideos("how to", 1, { channel: "UCabcdefghijklmnopqrstuv" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url(0).searchParams.get("channelId")).toBe("UCabcdefghijklmnopqrstuv");
  });

  it("resolves a handle first, then restricts the search to it", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: "UCabcdefghijklmnopqrstuv" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [ITEM] }) });
    const r = await searchYouTubeVideos("how to", 1, { channel: "@acme" });
    expect(r).toHaveLength(1);
    expect(url(0).pathname).toContain("/channels");
    expect(url(0).searchParams.get("forHandle")).toBe("@acme");
    expect(url(1).searchParams.get("channelId")).toBe("UCabcdefghijklmnopqrstuv");
  });

  it("returns nothing, not everything, when the handle cannot be resolved", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) });
    expect(await searchYouTubeVideos("how to", 1, { channel: "@nobody" })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns nothing without a key", async () => {
    delete process.env.YOUTUBE_API_KEY;
    expect(await searchYouTubeVideos("x", 1, { channel: "@acme" })).toEqual([]);
    expect(await resolveYouTubeChannelId("@acme")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

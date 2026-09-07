import { describe, it, expect, vi, beforeEach } from "vitest";
import { GhostAdapter } from "../ghost";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => mockFetch.mockReset());

const adapter = new GhostAdapter({ type: "ghost", apiUrl: "https://ghost.example.com", adminApiKey: "5f0c1d2e3a4b5c6d7e8f9a0b:" + "ab".repeat(32) });
const sent = (call = 0) => JSON.parse(mockFetch.mock.calls[call][1].body).posts[0];

describe("GhostAdapter", () => {
  it("publish() sends the featured image as feature_image", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [{ id: "p1", url: "https://ghost.example.com/x/" }] }) });
    const res = await adapter.publish({
      title: "X",
      html: "<p>x</p>",
      slug: "x",
      featuredImageUrl: "https://cdn.example.com/hero.png",
      publishMode: "publish",
    });
    expect(res).toEqual({ externalId: "p1", url: "https://ghost.example.com/x/" });
    expect(sent()).toMatchObject({ title: "X", slug: "x", status: "published", feature_image: "https://cdn.example.com/hero.png" });
  });

  it("publish() sends no feature_image key when there is no image", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [{ id: "p1", url: "u" }] }) });
    await adapter.publish({ title: "X", html: "<p>x</p>", slug: "x" });
    expect(sent()).not.toHaveProperty("feature_image");
  });

  it("update() carries the featured image too", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [{ updated_at: "2026-09-07T00:00:00Z" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [{ id: "p1", url: "u" }] }) });
    await adapter.update("p1", { title: "X", html: "<p>x</p>", slug: "x", featuredImageUrl: "https://cdn.example.com/hero.png" });
    expect(sent(1)).toMatchObject({ feature_image: "https://cdn.example.com/hero.png", updated_at: "2026-09-07T00:00:00Z" });
  });
});

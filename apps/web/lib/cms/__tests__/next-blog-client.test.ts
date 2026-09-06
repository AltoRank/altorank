/**
 * packages/altorank-next-blog is not an npm workspace (apps/* only), so its
 * client is tested from here by relative path. It has no dependencies.
 */
import { describe, it, expect, vi } from "vitest";
import { BlogClient, BlogClientError } from "../../../../../packages/altorank-next-blog/src/client";

const opts = { apiKey: "fr_live_sk_test", workspaceId: "ws-1", baseUrl: "https://app.example/" };

describe("BlogClient", () => {
  it("requires a key and a workspace", () => {
    expect(() => new BlogClient({ workspaceId: "w", apiKey: "" })).toThrow(/apiKey/);
    expect(() => new BlogClient({ apiKey: "k", workspaceId: "" })).toThrow(/workspaceId/);
  });

  it("list() calls the articles route with the key as a bearer token and the ISR window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ articles: [{ id: "1", slug: "a", title: "A" }], page: 2, per_page: 5, total: 7 }),
    );
    const client = new BlogClient({ ...opts, fetch: fetchMock, revalidate: 3600 });

    const result = await client.list({ page: 2, perPage: 5 });
    expect(result.total).toBe(7);
    expect(result.articles[0].slug).toBe("a");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/blog/v1/articles?workspace_id=ws-1&page=2&per_page=5");
    expect(init.headers.Authorization).toBe("Bearer fr_live_sk_test");
    expect(init.next).toEqual({ revalidate: 3600 });
  });

  it("get() returns the article, or null on 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ article: { id: "1", slug: "my-post", title: "P", content_html: "<p>x</p>" } }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    const client = new BlogClient({ ...opts, fetch: fetchMock });

    const article = await client.get("my post");
    expect(article?.content_html).toBe("<p>x</p>");
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.example/api/blog/v1/articles/my%20post?workspace_id=ws-1");

    expect(await client.get("missing")).toBeNull();
  });

  it("throws a BlogClientError with the server's message on other failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "Invalid API key" }, { status: 401 }));
    const client = new BlogClient({ ...opts, fetch: fetchMock });
    await expect(client.get("x")).rejects.toMatchObject({
      name: "BlogClientError",
      status: 401,
      message: "AltoRank blog API returned 401: Invalid API key",
    });
    await expect(client.list()).rejects.toBeInstanceOf(BlogClientError);
  });

  it("listAll() walks the pages until it has every article", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ articles: [{ id: "1" }, { id: "2" }], page: 1, per_page: 100, total: 3 }))
      .mockResolvedValueOnce(Response.json({ articles: [{ id: "3" }], page: 2, per_page: 100, total: 3 }));
    const client = new BlogClient({ ...opts, fetch: fetchMock });
    const all = await client.listAll();
    expect(all.map((a) => a.id)).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

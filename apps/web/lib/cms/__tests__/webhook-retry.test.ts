import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebhookAdapter, MAX_ATTEMPTS, webhookArticle } from "../webhook";
import type { DeliveryAttempt } from "../types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const config = { type: "webhook" as const, url: "https://hook.example.com/in", secret: "s3cret" };

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** Run an adapter call to completion with fake timers, flushing the backoff waits. */
async function settle<T>(p: Promise<T>): Promise<T> {
  // Attach a no-op handler first so a rejection during timer flushing is not
  // reported as unhandled before the caller awaits it.
  p.catch(() => undefined);
  await vi.runAllTimersAsync();
  return p;
}

describe("WebhookAdapter retries", () => {
  it("retries on a network error and a 5xx, then succeeds, reporting every attempt", async () => {
    const attempts: DeliveryAttempt[] = [];
    const adapter = new WebhookAdapter(config, { onDelivery: (a) => void attempts.push(a) });

    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "ok-1", url: "https://site/x" }));

    const result = await settle(adapter.publish({ id: "a1", title: "T", html: "<p>x</p>", slug: "t" }));

    expect(result).toEqual({ externalId: "ok-1", url: "https://site/x" });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([
      { attempt: 1, maxAttempts: 3, ok: false, status: undefined, error: "ECONNRESET" },
      { attempt: 2, maxAttempts: 3, ok: false, status: 503, error: "HTTP 503: busy" },
      { attempt: 3, maxAttempts: 3, ok: true, status: 200 },
    ]);
  });

  it("gives up after three attempts", async () => {
    const attempts: DeliveryAttempt[] = [];
    const adapter = new WebhookAdapter(config, { onDelivery: (a) => void attempts.push(a) });
    // A fresh Response per call: a body can only be read once.
    mockFetch.mockImplementation(async () => new Response("down", { status: 500 }));

    await expect(settle(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }))).rejects.toThrow(
      "Webhook publish failed: HTTP 500: down",
    );
    expect(mockFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it("does not retry a 4xx other than 429", async () => {
    const attempts: DeliveryAttempt[] = [];
    const adapter = new WebhookAdapter(config, { onDelivery: (a) => void attempts.push(a) });
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 400 }));

    await expect(settle(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }))).rejects.toThrow(
      "HTTP 400",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
  });

  it("retries a 429", async () => {
    const adapter = new WebhookAdapter(config);
    mockFetch
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(Response.json({}));
    await settle(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("a failing delivery hook never fails the publish", async () => {
    const adapter = new WebhookAdapter(config, {
      onDelivery: () => {
        throw new Error("log db down");
      },
    });
    mockFetch.mockResolvedValueOnce(Response.json({ id: "x" }));
    const result = await settle(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }));
    expect(result.externalId).toBe("x");
  });
});

describe("WebhookAdapter contract", () => {
  it("publish_articles carries an array of contract-shaped articles and a bearer token", async () => {
    const adapter = new WebhookAdapter(config);
    mockFetch.mockResolvedValueOnce(Response.json({}));

    await settle(
      adapter.publish({
        id: "a1",
        title: "Title",
        html: "<p>body</p>",
        markdown: "---\ntitle: Title\n---\nbody\n",
        slug: "title",
        metaDescription: "d",
        featuredImageUrl: "https://img/x.png",
        tags: ["t1"],
        createdAt: "2026-09-04T10:00:00.000Z",
      }),
    );

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer s3cret");
    expect(opts.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(opts.body)).toEqual({
      event: "publish_articles",
      // The connection's publishing behaviour rides in the envelope (#83);
      // a payload that does not say defaults to a live publish.
      publishMode: "publish",
      articles: [
        {
          id: "a1",
          title: "Title",
          content_markdown: "---\ntitle: Title\n---\nbody\n",
          content_html: "<p>body</p>",
          meta_description: "d",
          created_at: "2026-09-04T10:00:00.000Z",
          image_url: "https://img/x.png",
          slug: "title",
          tags: ["t1"],
        },
      ],
    });
  });

  it("falls back to our article id when the endpoint returns none", async () => {
    const adapter = new WebhookAdapter(config);
    mockFetch.mockResolvedValueOnce(new Response("accepted", { status: 202 }));
    const result = await settle(adapter.publish({ id: "a9", title: "T", html: "<p>x</p>", slug: "t" }));
    expect(result.externalId).toBe("a9");
  });

  it("update_article is a single article named by id", async () => {
    const adapter = new WebhookAdapter(config);
    mockFetch.mockResolvedValueOnce(Response.json({}));
    await settle(adapter.update("ext-7", { title: "T", html: "<p>x</p>", slug: "t" }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.event).toBe("update_article");
    expect(body.article.id).toBe("ext-7");
  });

  it("sends no Authorization header without a secret", async () => {
    const adapter = new WebhookAdapter({ type: "webhook", url: config.url });
    mockFetch.mockResolvedValueOnce(Response.json({}));
    await settle(adapter.publish({ title: "T", html: "<p>x</p>", slug: "t" }));
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Webhook-Signature"]).toBeUndefined();
  });

  it("webhookArticle() defaults the optional fields to null/empty, never undefined", () => {
    const a = webhookArticle({ title: "T", html: "<p>x</p>", slug: "t" });
    expect(a.id).toBeNull();
    expect(a.meta_description).toBeNull();
    expect(a.image_url).toBeNull();
    expect(a.tags).toEqual([]);
    expect(a.content_markdown).toBe("");
    expect(typeof a.created_at).toBe("string");
  });
});

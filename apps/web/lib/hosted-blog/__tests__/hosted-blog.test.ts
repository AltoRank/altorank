import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "@/lib/agent/__tests__/fake-supabase";

/**
 * The hosted blog (app/b/[slug]) shows exactly what the blog API serves: live
 * articles, minus one found live on the customer's own site, and nothing at
 * all for a blog that is off or an account the trial gate holds. Every read is
 * the service client in a narrow query, since the pages are public.
 */

const ws = (over: Record<string, unknown>) => ({
  account_id: "acc-1",
  domain: "acme.example",
  language: "en",
  brand_style: {},
  hosted_blog_host: null,
  profile_name: "Acme Physio",
  ...over,
});

const art = (over: Record<string, unknown>) => ({
  workspace_id: "ws-on",
  status: "live",
  found_on_site_at: null,
  meta_description: null,
  featured_image_url: null,
  updated_at: "2026-10-01T10:00:00Z",
  content: { type: "doc", content: [] },
  ...over,
});

let sb: ReturnType<typeof fakeSupabase>;
let selects: Array<[string, string]>;
let gate: "open" | "gated" = "open";
let requestHost: string | null = "app.altorank.co";

function seed() {
  sb = fakeSupabase({
    workspaces: [
      ws({ id: "ws-on", hosted_blog_slug: "acme", hosted_blog_status: "preview" }),
      ws({ id: "ws-off", hosted_blog_slug: "dark", hosted_blog_status: "off" }),
      ws({ id: "ws-ver", hosted_blog_slug: "verified", hosted_blog_status: "verified", hosted_blog_host: "blog.acme.example" }),
    ],
    workspace_output_settings: [{ workspace_id: "ws-on", brand_color: "#0E7C66" }],
    articles: [
      art({ id: "a-live", slug: "live-one", title: "Live", published_at: "2026-10-02T10:00:00Z" }),
      art({ id: "a-live-2", slug: "live-two", title: "Live & <older>", published_at: "2026-09-02T10:00:00Z" }),
      art({ id: "a-found", slug: "found", title: "Found on site", published_at: "2026-10-03T10:00:00Z", found_on_site_at: "2026-10-04T10:00:00Z" }),
      art({ id: "a-draft", slug: "draft", title: "Draft", status: "review", published_at: null }),
      art({ id: "a-approved", slug: "approved", title: "Approved", status: "approved", published_at: null }),
      art({ id: "a-other", workspace_id: "ws-ver", slug: "other", title: "Other site", published_at: "2026-10-05T10:00:00Z" }),
    ],
  });
  selects = [];
  const from = sb.from.bind(sb);
  (sb as { from: unknown }).from = (table: string) => {
    const q = from(table) as { select: (c?: string, o?: unknown) => unknown };
    const select = q.select;
    q.select = (c?: string, o?: unknown) => {
      selects.push([table, c ?? "*"]);
      return select(c, o);
    };
    return q;
  };
}

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => sb }));
vi.mock("@/lib/billing/body-lock", () => ({ accountTrialGate: async () => gate }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestHost ? { host: requestHost } : {}),
}));

beforeEach(() => {
  seed();
  gate = "open";
  requestHost = "app.altorank.co";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});

describe("getHostedSite", () => {
  it("finds a blog that is on, with its brand colour", async () => {
    const { getHostedSite } = await import("../data");
    const site = await getHostedSite("acme");
    expect(site).toMatchObject({ id: "ws-on", status: "preview", name: "Acme Physio", domain: "acme.example", accent: "#0e7c66" });
  });

  it("is null for a blog that is off, an unknown slug and a malformed one", async () => {
    const { getHostedSite } = await import("../data");
    expect(await getHostedSite("dark")).toBeNull();
    expect(await getHostedSite("nobody")).toBeNull();
    expect(await getHostedSite("Acme")).toBeNull();
    expect(await getHostedSite("../acme")).toBeNull();
  });

  it("is null for an account behind the trial gate", async () => {
    const { getHostedSite } = await import("../data");
    gate = "gated";
    expect(await getHostedSite("acme")).toBeNull();
  });

  it("reads named columns only", async () => {
    const { getHostedSite } = await import("../data");
    await getHostedSite("acme");
    const ws = selects.find(([t]) => t === "workspaces")![1];
    expect(ws).not.toContain("*");
    expect(ws).not.toMatch(/\bbusiness_profile\b(?!->>)/);
    expect(ws).not.toMatch(/api_key|stripe|share_token|indexnow_key/);
  });
});

describe("listHostedArticles / getHostedArticle", () => {
  it("lists live articles of that site only, newest first, without one found on the site", async () => {
    const { listHostedArticles } = await import("../data");
    const { articles } = await listHostedArticles("ws-on", 1);
    expect(articles.map((a) => a.id)).toEqual(["a-live", "a-live-2"]);
    expect(selects.find(([t]) => t === "articles")![1]).not.toContain("content");
  });

  it("reads one live article by slug, and nothing that is not live or was found on the site", async () => {
    const { getHostedArticle } = await import("../data");
    expect((await getHostedArticle("ws-on", "live-one"))?.id).toBe("a-live");
    expect(await getHostedArticle("ws-on", "found")).toBeNull();
    expect(await getHostedArticle("ws-on", "draft")).toBeNull();
    expect(await getHostedArticle("ws-on", "approved")).toBeNull();
    expect(await getHostedArticle("ws-on", "other")).toBeNull();
  });
});

describe("a page past the last", () => {
  it("is an empty page, not an error (PostgREST answers PGRST103)", async () => {
    const { listHostedArticles } = await import("../data");
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order"]) chain[m] = () => chain;
    chain.range = async () => ({ data: null, count: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } });
    const client = { from: () => chain } as unknown as Parameters<typeof listHostedArticles>[2];
    expect(await listHostedArticles("ws-on", 9, client)).toEqual({ articles: [], total: 0 });
  });
});

describe("hostedBlogUrls", () => {
  it("previews at /b/<slug>, noindex, canonical on the preview URL", async () => {
    const { hostedBlogUrls } = await import("../data");
    expect(hostedBlogUrls({ slug: "acme", host: "blog.acme.example", status: "pending_dns" }, "app.altorank.co")).toEqual({
      canonicalRoot: "https://app.altorank.co/b/acme",
      linkRoot: "/b/acme",
      indexable: false,
    });
  });

  it("moves the canonical to the host once verified; only that host is indexable", async () => {
    const { hostedBlogUrls } = await import("../data");
    const site = { slug: "acme", host: "blog.acme.example", status: "verified" as const };
    expect(hostedBlogUrls(site, "app.altorank.co")).toEqual({
      canonicalRoot: "https://blog.acme.example",
      linkRoot: "/b/acme",
      indexable: false,
    });
    expect(hostedBlogUrls(site, "blog.acme.example")).toEqual({
      canonicalRoot: "https://blog.acme.example",
      linkRoot: "",
      indexable: true,
    });
  });
});

describe("accentFrom", () => {
  it("takes the settings' colour, then a hex in brand_style.colors, else none", async () => {
    const { accentFrom } = await import("../data");
    expect(accentFrom("#AABBCC", { colors: ["#112233"] })).toBe("#aabbcc");
    expect(accentFrom(null, { colors: ["#112233"] })).toBe("#112233");
    expect(accentFrom(null, { colors: "navy #445566 and white" })).toBe("#445566");
    expect(accentFrom("red", { colors: "navy" })).toBeNull();
    expect(accentFrom("#abc;}body{", null)).toBeNull();
  });
});

describe("sitemap.xml and rss.xml", () => {
  const call = async (file: "sitemap.xml" | "rss.xml", slug: string) => {
    const mod = file === "sitemap.xml" ? await import("@/app/b/[slug]/sitemap.xml/route") : await import("@/app/b/[slug]/rss.xml/route");
    return mod.GET(new Request(`https://app.altorank.co/b/${slug}/${file}`, { headers: { host: requestHost ?? "" } }), {
      params: Promise.resolve({ slug }),
    });
  };

  it("lists the live articles at their canonical address, noindex on the preview path", async () => {
    const res = await call("sitemap.xml", "acme");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await res.text();
    expect(body).toContain("<loc>https://app.altorank.co/b/acme/live-one</loc>");
    expect(body).toContain("<loc>https://app.altorank.co/b/acme/live-two</loc>");
    expect(body).not.toMatch(/found|draft|approved|other/);
  });

  it("serves an escaped RSS feed of the same rows", async () => {
    const res = await call("rss.xml", "acme");
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const body = await res.text();
    expect(body).toContain("<title>Live &amp; &lt;older&gt;</title>");
    expect(body.match(/<item>/g)).toHaveLength(2);
  });

  it("is a 404 for a blog that is off or unknown", async () => {
    expect((await call("sitemap.xml", "dark")).status).toBe(404);
    expect((await call("rss.xml", "nobody")).status).toBe(404);
  });

  it("is indexable on the verified host, with the host as the canonical root", async () => {
    requestHost = "blog.acme.example";
    const res = await call("sitemap.xml", "verified");
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(await res.text()).toContain("<loc>https://blog.acme.example/other</loc>");
  });
});

describe("page metadata", () => {
  it("the index is noindex with the preview URL as canonical", async () => {
    const { generateMetadata } = await import("@/app/b/[slug]/page");
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "acme" }), searchParams: Promise.resolve({}) });
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toBe("https://app.altorank.co/b/acme");
  });

  it("an article's canonical is on the verified host", async () => {
    const { generateMetadata } = await import("@/app/b/[slug]/[article]/page");
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "verified", article: "other" }) });
    expect(meta.alternates?.canonical).toBe("https://blog.acme.example/other");
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it("an article that is not live has no page", async () => {
    const { generateMetadata } = await import("@/app/b/[slug]/[article]/page");
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "acme", article: "draft" }) });
    expect(meta.title).toEqual({ absolute: "Not found" });
  });
});

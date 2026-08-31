import { describe, it, expect, vi, afterEach } from "vitest";
import { detectPlatform } from "../detect";

// Every fixture below is the shape a real site returned on 2026-08-30. The
// rules were tuned against live fetches first and pinned here afterwards, in
// that order: a detector tested only against its own fixtures proves nothing
// except that the author was consistent.

function serve(html: string, headers: Record<string, string> = {}, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(html, { status: ok ? 200 : 500, headers })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("detectPlatform", () => {
  it("reads a WordPress generator tag", async () => {
    serve('<meta name="generator" content="WordPress 7.2-alpha-63393" />');
    const r = await detectPlatform("example.com");
    expect(r?.platform).toBe("wordpress");
    expect(r?.confidence).toBe("high");
  });

  it("does not call wordpress.org a WooCommerce store", async () => {
    // The live page mentions "WooCommerceBlocks" in marketing copy. An earlier
    // rule matched that word anywhere and reported a shop that does not exist.
    serve(
      '<meta name="generator" content="WordPress 7.2" /><p>WooCommerceBlocks is great</p>',
    );
    expect((await detectPlatform("wordpress.org"))?.platform).toBe("wordpress");
  });

  it("detects WooCommerce from a real plugin asset path", async () => {
    serve('<link href="/wp-content/plugins/woocommerce/assets/css/x.css">');
    expect((await detectPlatform("shop.example"))?.platform).toBe("woocommerce");
  });

  it("prefers a Shopify response header over page content", async () => {
    serve("<html></html>", { "x-shopid": "12345" });
    expect((await detectPlatform("store.example"))?.platform).toBe("shopify");
  });

  it("detects Webflow from its site attributes", async () => {
    serve('<html data-wf-page="abc" data-wf-site="def">');
    expect((await detectPlatform("example.com"))?.platform).toBe("webflow");
  });

  it("routes a repo-built site to the git adapter", async () => {
    serve('<script src="/_next/static/chunks/main.js"></script>');
    const r = await detectPlatform("example.com");
    expect(r?.platform).toBe("nextjs");
    expect(r?.adapter).toBe("git");
  });

  it("flags Squarespace as having no publishing adapter", async () => {
    serve('<script src="https://static1.squarespace.com/x.js"></script>');
    expect((await detectPlatform("example.com"))?.adapter).toBe("none");
  });

  it("returns null rather than guessing when nothing matches", async () => {
    // altorank.co is Astro and emits no generator tag. No match is the correct
    // answer; a guess would send someone hunting for credentials that do not
    // exist.
    serve("<html><body><h1>A hand-built page</h1></body></html>");
    expect(await detectPlatform("example.com")).toBeNull();
  });

  it("returns null when the site cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("dns"); }));
    expect(await detectPlatform("nope.invalid")).toBeNull();
  });

  it("returns null on a non-200", async () => {
    serve("<html></html>", {}, false);
    expect(await detectPlatform("example.com")).toBeNull();
  });

  it("always names the evidence it matched on", async () => {
    serve('<meta name="generator" content="Ghost 5.0" />');
    const r = await detectPlatform("example.com");
    expect(r?.evidence).toBeTruthy();
  });
});

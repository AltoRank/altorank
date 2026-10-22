import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The request's headers: a Referer the page falls back to when the URL brings
// no `ref`, and the app's own Host.
let requestHeaders: Record<string, string> = {};
vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestHeaders),
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

import SignUpPage from "../page";

beforeEach(() => {
  requestHeaders = { host: "app.altorank.co" };
});

// The page is an async server component: call it, then render what it returns.
// No database is touched; the action is not invoked here.
async function render(params: Record<string, string>): Promise<string> {
  const element = await SignUpPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

// The source fields only: a domain carried from the homepage rides in a hidden
// input too, once the form has moved on to the email.
const hidden = (html: string) =>
  [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]).filter(([name]) => name !== "domain");

describe("/signup carries the signup source into its form", () => {
  it("renders one hidden input per source value from the URL", async () => {
    const html = await render({
      domain: "acme.com",
      src: "/pricing/",
      ref: "news.ycombinator.com",
      utm_source: "newsletter",
      utm_campaign: "spring sale",
    });
    expect(hidden(html)).toEqual([
      ["src", "/pricing/"],
      ["ref", "news.ycombinator.com"],
      ["utm_source", "newsletter"],
      ["utm_campaign", "spring sale"],
    ]);
  });

  it("keeps them on the page an error redirect lands on", async () => {
    const html = await render({ error: "Enter your website as a domain, like acme.com.", src: "/check/", utm_medium: "email" });
    expect(html).toContain("Enter your website as a domain");
    expect(hidden(html)).toEqual([
      ["src", "/check/"],
      ["utm_medium", "email"],
    ]);
  });

  it("starts on the email when the homepage already gave the domain, and on the domain otherwise", async () => {
    const carried = await render({ domain: "acme.com" });
    expect(carried).toContain('name="domain" value="acme.com"');
    expect(carried).toContain('name="email"');
    expect(carried).not.toContain('name="password"');
    const fresh = await render({});
    expect(fresh).toContain('id="signup-domain"');
    expect(fresh).not.toContain('name="email"');
  });

  it("carries the landing page `lp` the marketing site adds", async () => {
    const html = await render({ src: "/pricing/", lp: "/alternatives/outrank/", ref: "www.google.com" });
    expect(hidden(html)).toEqual([
      ["src", "/pricing/"],
      ["lp", "/alternatives/outrank/"],
      ["ref", "www.google.com"],
    ]);
  });

  it("takes `ref` from the Referer when a visitor came straight here from another site", async () => {
    requestHeaders.referer = "https://chatgpt.com/";
    expect(hidden(await render({}))).toEqual([["ref", "chatgpt.com"]]);
    expect(hidden(await render({ utm_source: "chatgpt.com" }))).toEqual([
      ["ref", "chatgpt.com"],
      ["utm_source", "chatgpt.com"],
    ]);
  });

  it("keeps the `ref` the URL brought over the Referer, and never records itself or altorank.co", async () => {
    requestHeaders.referer = "https://chatgpt.com/";
    expect(hidden(await render({ ref: "www.google.com" }))).toEqual([["ref", "www.google.com"]]);
    // An error redirect back to the form, and a link from the marketing site
    // that was not tagged.
    requestHeaders.referer = "https://app.altorank.co/signup?error=x";
    expect(hidden(await render({ src: "/pricing/" }))).toEqual([["src", "/pricing/"]]);
    requestHeaders.referer = "https://altorank.co/";
    expect(hidden(await render({}))).toEqual([]);
  });

  it("hands the source on to its Sign in link", async () => {
    const html = await render({ src: "/pricing/", lp: "/blog/x/" });
    expect(html).toContain('href="/signin?src=%2Fpricing%2F&amp;lp=%2Fblog%2Fx%2F"');
    expect(await render({})).toContain('href="/signin"');
  });

  it("echoes nothing that fails the shape checks, and nothing at all without a source", async () => {
    expect(hidden(await render({ src: '/"><script>', ref: "https://x.com/", utm_source: "<b>" }))).toEqual([]);
    expect(hidden(await render({}))).toEqual([]);
  });
});

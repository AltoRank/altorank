import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SignUpPage from "../page";

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

  it("echoes nothing that fails the shape checks, and nothing at all without a source", async () => {
    expect(hidden(await render({ src: '/"><script>', ref: "https://x.com/", utm_source: "<b>" }))).toEqual([]);
    expect(hidden(await render({}))).toEqual([]);
  });
});

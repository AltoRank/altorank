/**
 * The embedded app's renderers. They build Polaris markup as strings, so the
 * thing to prove is that nothing from the server reaches the page unescaped.
 */
import { describe, it, expect } from "vitest";
// Plain JS served as-is from public/ (no build step).
import { esc, renderQueue, renderArticle, renderHome, renderFirstLook } from "../../../public/shopify/app.js";

const evil = `<img src=x onerror=alert(1)>"'`;

describe("embedded renderers", () => {
  it("escapes markup", () => {
    expect(esc(evil)).toBe("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;");
  });

  it("never puts a title or keyword in the page raw", () => {
    const html = renderQueue([{ id: "a1", title: evil, keyword: evil, status: "review", statusLabel: evil }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("puts no article body in the page: it goes to a sandboxed iframe", () => {
    const html = renderArticle({
      id: "a1", title: "T", keyword: "k", status: "review", statusLabel: "Awaiting review",
      html: "<script>alert(1)</script>", canApprove: true, approveBlockedReason: "",
    });
    expect(html).not.toContain("alert(1)");
    expect(html).toMatch(/<iframe[^>]*sandbox=""/);
    expect(html).toContain('data-action="approve"');
  });

  it("disables Approve and says why when the account cannot approve", () => {
    const html = renderArticle({
      id: "a1", title: "T", keyword: "k", status: "review", statusLabel: "Awaiting review",
      html: "", canApprove: false, approveBlockedReason: "Choose a plan to approve.",
    });
    expect(html).toMatch(/data-action="approve"[^>]*disabled/);
    expect(html).toContain("Choose a plan to approve.");
  });

  it("renders the home screen", () => {
    const html = renderHome({
      site: { domain: "fern.com" },
      firstLook: { state: "running", message: "Reading your pages", progress: 40 },
      queue: [],
      connection: { blogs: [{ id: "1", title: "News" }], blogId: "1", publishMode: "draft", needsReconnect: false },
      plan: { label: "No plan yet", line: "Approving needs a plan." },
      account: { ownerEmail: "a@fern.com", ownerReachable: true },
    });
    expect(html).toContain("Reading your store");
    expect(html).toContain('value="40"');
    expect(html).toContain("a@fern.com");
  });

  it("explains an empty first look and offers to run it again", () => {
    const html = renderFirstLook({ state: "empty", message: "Your storefront is password-protected <b>", storefrontLocked: true });
    expect(html).toContain("Your storefront is locked");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain('data-action="retry-first-look"');
  });
});

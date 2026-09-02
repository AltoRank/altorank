import { describe, it, expect } from "vitest";
import type { Quota } from "@/lib/billing/quota";
import {
  appendAttribution,
  isOperatorAgency,
  attributionHtml,
  shouldAttribute,
  ATTRIBUTION_ANCHOR,
  ATTRIBUTION_URL,
} from "@/lib/publishing/attribution";

function quota(reason: Quota["reason"]): Quota {
  return { limit: null, used: 0, remaining: null, reason, plan: null };
}

describe("shouldAttribute", () => {
  it("brands the hosted free tier", () => {
    expect(shouldAttribute(quota("no-plan"), false)).toBe(true);
  });

  it("leaves paid, operator and self-host articles clean", () => {
    for (const reason of ["plan", "operator", "self-host"] as const) {
      expect(shouldAttribute(quota(reason), false)).toBe(false);
    }
  });

  it("does not let the white-label toggle remove the free-tier line", () => {
    // Otherwise the setting is the gate, and free is white-label with an
    // extra click.
    expect(shouldAttribute(quota("no-plan"), true)).toBe(true);
  });
});

describe("attributionHtml", () => {
  it("links to the bare canonical URL with a branded anchor", () => {
    const html = attributionHtml();
    expect(html).toContain(`href="${ATTRIBUTION_URL}"`);
    expect(html).toContain(ATTRIBUTION_ANCHOR);
    // A query string would split the link target across URLs.
    expect(html).not.toContain("?");
  });
});

describe("appendAttribution", () => {
  it("appends the line to a body", () => {
    expect(appendAttribution("<p>Body</p>")).toContain("Powered by");
  });

  it("is idempotent, so republishing does not stack badges", () => {
    const once = appendAttribution("<p>Body</p>");
    expect(appendAttribution(once)).toBe(once);
  });

  it("keeps the original body intact", () => {
    expect(appendAttribution("<h2>Title</h2><p>Body</p>")).toContain("<h2>Title</h2><p>Body</p>");
  });
});

describe("isOperatorAgency", () => {
  function client(email: string | null) {
    return {
      from: () => ({ select: () => ({ eq: async () => ({ data: [{ user_id: "u1" }] }) }) }),
      auth: { admin: { getUserById: async () => ({ data: email ? { user: { email } } : null }) } },
    } as never;
  }

  it("recognises an operator-owned agency", async () => {
    expect(await isOperatorAgency(client("helloaltorank@gmail.com"), "a1")).toBe(true);
  });

  it("does not flag a customer agency", async () => {
    expect(await isOperatorAgency(client("someone@example.com"), "a1")).toBe(false);
  });

  it("answers false when the address cannot be read, rather than throwing", async () => {
    // A request-scoped client has no service role; the publish must not fail.
    const noAdmin = {
      from: () => ({ select: () => ({ eq: async () => ({ data: [{ user_id: "u1" }] }) }) }),
      auth: { admin: { getUserById: async () => { throw new Error("not authorized"); } } },
    } as never;
    expect(await isOperatorAgency(noAdmin, "a1")).toBe(false);
  });
});

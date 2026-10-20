import { describe, expect, it } from "vitest";
import { originSearchText, signupEventsByUser, userOrigin } from "../user-origin";

describe("userOrigin", () => {
  it("leads with the campaign, then the referrer, then the page", () => {
    expect(userOrigin({ stage: "created", src: "/pricing/", ref: "news.ycombinator.com", utm: { source: "newsletter", medium: "email", campaign: "oct" } })).toEqual({
      kind: "campaign",
      label: "newsletter",
      detail: "email / oct · from /pricing/",
    });
    expect(userOrigin({ stage: "created", src: "/blog/geo/", ref: "www.google.com" })).toEqual({ kind: "referrer", label: "www.google.com", detail: "from /blog/geo/" });
    expect(userOrigin({ stage: "created", src: "/pricing/" })).toEqual({ kind: "page", label: "/pricing/", detail: "no referrer or campaign" });
  });

  it("names the door when it was not the signup form", () => {
    expect(userOrigin({ stage: "created", source: "signin_code" })).toMatchObject({ kind: "door", label: "Sign-in code" });
    expect(userOrigin({ stage: "created", source: "shopify", shop: "x.myshopify.com" } as never)).toMatchObject({ kind: "door", label: "Shopify App Store" });
    expect(userOrigin({ stage: "fallback" })).toMatchObject({ kind: "door", label: "Membership fallback" });
  });

  it("says direct for the signup form with nothing on its link", () => {
    expect(userOrigin({ stage: "created", domain: "acme.com" } as never)).toMatchObject({ kind: "direct", label: "Direct" });
  });

  it("says invited, or not recorded, when there is no signup event", () => {
    expect(userOrigin(undefined, { invited: true })).toMatchObject({ kind: "invited", label: "Invited" });
    expect(userOrigin(undefined)).toEqual({ kind: "unknown", label: "—", detail: "not recorded" });
  });

  it("ignores values that are not text", () => {
    expect(userOrigin({ stage: "created", utm: { source: 42 }, ref: ["x"], src: "" })).toMatchObject({ kind: "direct" });
  });
});

describe("signupEventsByUser", () => {
  it("keeps each user's first account-creating event and skips the error rows", () => {
    const map = signupEventsByUser([
      { created_at: "2026-10-02T00:00:00Z", context: { stage: "created", userId: "u1", ref: "second" } },
      { created_at: "2026-10-01T00:00:00Z", context: { stage: "created", userId: "u1", ref: "first" } },
      { created_at: "2026-10-01T00:00:00Z", context: { stage: "account", userId: "u2" } },
      { created_at: "2026-10-01T00:00:00Z", context: { stage: "fallback", userId: "u3" } },
      { created_at: "2026-10-01T00:00:00Z", context: null },
    ]);
    expect(map.get("u1")?.ref).toBe("first");
    expect(map.has("u2")).toBe(false);
    expect(map.get("u3")?.stage).toBe("fallback");
  });
});

describe("originSearchText", () => {
  it("is searchable by source and campaign, and empty for an unknown one", () => {
    expect(originSearchText(userOrigin({ stage: "created", utm: { source: "google", campaign: "brand" } }))).toContain("google");
    expect(originSearchText(userOrigin(undefined)).trim()).toBe("not recorded");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  signUnsubscribe,
  verifyUnsubscribe,
  unsubscribeUrl,
  unsubscribePostUrl,
  unsubscribeHeaders,
  readUnsubscribeParams,
} from "../unsubscribe";
import { wantsCategory, isOptional } from "../categories";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "a-test-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.altorank.co";
});
afterAll(() => {
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("the unsubscribe signature", () => {
  it("verifies its own link", () => {
    const sig = signUnsubscribe("a@x.co", "drafts")!;
    expect(verifyUnsubscribe("a@x.co", "drafts", sig)).toBe(true);
  });

  /**
   * The reason the link is signed at all: unsigned, the URL is a form anybody
   * can fill in to silence anybody else's mail.
   */
  it("does not verify for a different address or category", () => {
    const sig = signUnsubscribe("a@x.co", "drafts")!;
    expect(verifyUnsubscribe("b@x.co", "drafts", sig)).toBe(false);
    expect(verifyUnsubscribe("a@x.co", "reports", sig)).toBe(false);
  });

  it("is case- and whitespace-insensitive about the address", () => {
    const sig = signUnsubscribe(" A@X.co ", "drafts")!;
    expect(verifyUnsubscribe("a@x.co", "drafts", sig)).toBe(true);
  });

  it("rejects a truncated signature without throwing", () => {
    const sig = signUnsubscribe("a@x.co", "drafts")!;
    expect(verifyUnsubscribe("a@x.co", "drafts", sig.slice(0, 10))).toBe(false);
  });
});

describe("the link", () => {
  it("carries the address, the category and the signature", () => {
    const u = new URL(unsubscribeUrl("a@x.co", "reports")!);
    expect(u.origin + u.pathname).toBe("https://app.altorank.co/unsubscribe");
    expect(u.searchParams.get("e")).toBe("a@x.co");
    expect(u.searchParams.get("c")).toBe("reports");
    expect(verifyUnsubscribe("a@x.co", "reports", u.searchParams.get("s")!)).toBe(true);
  });

  it("has a POST twin for one-click clients", () => {
    expect(unsubscribePostUrl("a@x.co", "reports")).toContain("/api/unsubscribe?");
  });

  it("produces the RFC 8058 header pair", () => {
    const h = unsubscribeHeaders("a@x.co", "drafts")!;
    expect(h["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.altorank\.co\/api\/unsubscribe\?/);
    expect(h["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

describe("readUnsubscribeParams", () => {
  const params = (e: string, c: string, s: string) => new URLSearchParams({ e, c, s });

  it("accepts a well-formed link", () => {
    const sig = signUnsubscribe("a@x.co", "drafts")!;
    expect(readUnsubscribeParams(params("a@x.co", "drafts", sig))).toEqual({
      ok: true,
      email: "a@x.co",
      category: "drafts",
    });
  });

  it("accepts the 'all' pseudo-category", () => {
    const sig = signUnsubscribe("a@x.co", "all")!;
    expect(readUnsubscribeParams(params("a@x.co", "all", sig))).toMatchObject({ ok: true, category: "all" });
  });

  it("refuses a missing parameter, an unknown category and a bad signature", () => {
    expect(readUnsubscribeParams(params("", "drafts", "x"))).toMatchObject({ ok: false });
    expect(readUnsubscribeParams(params("a@x.co", "nonsense", signUnsubscribe("a@x.co", "nonsense")!))).toMatchObject({
      ok: false,
    });
    expect(readUnsubscribeParams(params("a@x.co", "drafts", "deadbeef".repeat(4)))).toMatchObject({ ok: false });
  });
});

describe("which categories may be refused", () => {
  /**
   * The line the product draws: refusing an optional email costs the person
   * nothing; refusing a required one would leave them unable to do something
   * they need to do.
   */
  it("treats work notices as optional and access, security and money as required", () => {
    expect(["drafts", "publishing", "improvements", "reports", "product"].every(isOptional as never)).toBe(true);
    expect(["auth", "account", "billing"].some(isOptional as never)).toBe(false);
  });

  it("ignores the opt-out list for a required category", () => {
    expect(wantsCategory(["all"], "billing")).toBe(true);
    expect(wantsCategory(["all"], "reports")).toBe(false);
    expect(wantsCategory(["drafts"], "reports")).toBe(true);
    expect(wantsCategory(null, "reports")).toBe(true);
  });
});

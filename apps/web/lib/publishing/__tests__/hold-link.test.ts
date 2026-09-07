import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { holdUrl, readHoldParams, signHold, verifyHold } from "../hold-link";

const ARTICLE = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

describe("hold link", () => {
  const prev = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  beforeEach(() => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    else process.env.EMAIL_UNSUBSCRIBE_SECRET = prev;
  });

  it("round-trips through the URL it renders", () => {
    const url = new URL(holdUrl(ARTICLE, "Owner@Acme.co")!);
    expect(url.pathname).toBe("/hold");
    const parsed = readHoldParams(url.searchParams);
    expect(parsed).toEqual({ ok: true, articleId: ARTICLE, email: "owner@acme.co" });
  });

  it("binds the article and the address together", () => {
    const sig = signHold(ARTICLE, "owner@acme.co")!;
    expect(verifyHold(OTHER, "owner@acme.co", sig)).toBe(false);
    expect(verifyHold(ARTICLE, "intruder@acme.co", sig)).toBe(false);
    expect(verifyHold(ARTICLE, "owner@acme.co", sig)).toBe(true);
  });

  it("refuses an incomplete or tampered link with a reason", () => {
    expect(readHoldParams(new URLSearchParams({ a: ARTICLE, e: "x@y.z" }))).toMatchObject({ ok: false });
    expect(readHoldParams(new URLSearchParams({ a: "not-a-uuid", e: "x@y.z", s: "abc" }))).toMatchObject({ ok: false });
    const url = new URL(holdUrl(ARTICLE, "owner@acme.co")!);
    url.searchParams.set("s", "0".repeat(32));
    expect(readHoldParams(url.searchParams)).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
  });

  it("renders no link at all when no secret is configured", () => {
    delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(holdUrl(ARTICLE, "owner@acme.co")).toBeNull();
    if (prevKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  });
});

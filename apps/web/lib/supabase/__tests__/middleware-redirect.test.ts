// The sign-in bounce must carry the destination, not the query that happened
// to be sitting on it. `/articles?status=review` → `/signin?status=review` kept
// the wrong half: eight of the twenty-four emails end in a link to an
// auth-gated page, and every one of them landed the reader on the dashboard.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

import { updateSession } from "../middleware";

const ORIGIN = "https://app.altorank.co";

function get(path: string) {
  return updateSession(new NextRequest(new URL(path, ORIGIN)));
}

beforeEach(() => {
  getUser.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});

describe("with no session", () => {
  beforeEach(() => getUser.mockResolvedValue({ data: { user: null } }));

  it("sends a private page to /signin with the whole destination in next", async () => {
    const res = await get("/articles?status=review");
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/signin");
    expect(to.searchParams.get("next")).toBe("/articles?status=review");
    // The bounced page's own parameters must not ride along beside it.
    expect(to.searchParams.get("status")).toBeNull();
  });

  it("carries a bare path too", async () => {
    const to = new URL((await get("/content/abc")).headers.get("location")!);
    expect(to.searchParams.get("next")).toBe("/content/abc");
  });

  /** The regression this branch opened with: /hold must be served, not bounced. */
  it("serves /hold, so a signed hold link works from an email", async () => {
    const res = await get("/hold?a=art-1&e=someone%40example.com&s=deadbeef");
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("serves /unsubscribe on the same terms", async () => {
    expect((await get("/unsubscribe?e=a%40x.co&c=drafts&s=abc")).status).toBe(200);
  });
});

describe("with a session", () => {
  beforeEach(() => getUser.mockResolvedValue({ data: { user: { id: "u1" } } }));

  it("sends someone already signed in straight to the mailed page", async () => {
    const to = new URL((await get("/signin?next=%2Farticles%3Fstatus%3Dreview")).headers.get("location")!);
    expect(to.pathname).toBe("/articles");
    expect(to.search).toBe("?status=review");
  });

  it("falls back to the dashboard with no next", async () => {
    const to = new URL((await get("/signin")).headers.get("location")!);
    expect(to.pathname).toBe("/dashboard");
  });

  /**
   * The open redirect this parameter would be if nothing checked it. A hostile
   * `next` must land the reader on the dashboard, on this origin.
   */
  it.each([
    "https://evil.com/phish",
    "//evil.com",
    "/\\evil.com",
    "/%2f%2fevil.com",
    "javascript:alert(1)",
  ])("refuses next=%s and goes to the dashboard", async (hostile) => {
    const to = new URL((await get(`/signin?next=${encodeURIComponent(hostile)}`)).headers.get("location")!);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe("/dashboard");
  });
});

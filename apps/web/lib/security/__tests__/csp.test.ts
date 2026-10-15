import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp, makeNonce } from "../csp";

// The dashboard's Content-Security-Policy. Pinned: inline script runs only
// with the request's nonce, nothing can be embedded from or framed by another
// origin, and the services the app does talk to stay reachable.

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

const PROD = directives(
  buildCsp({ nonce: "abc123==", supabaseUrl: "https://project.supabase.co", posthogHost: "https://eu.i.posthog.com" }),
);

describe("buildCsp", () => {
  it("runs script only with the request's nonce: no inline, no eval, no host allowlist bypass", () => {
    expect(PROD["script-src"]).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    expect(PROD["script-src"]).not.toContain("'unsafe-inline'");
    expect(PROD["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("refuses plugins, base rewriting and framing by any other origin", () => {
    expect(PROD["object-src"]).toEqual(["'none'"]);
    expect(PROD["base-uri"]).toEqual(["'self'"]);
    expect(PROD["frame-ancestors"]).toEqual(["'none'"]);
    expect(PROD["default-src"]).toEqual(["'self'"]);
  });

  it("reaches Supabase (REST, auth, realtime) and PostHog, and nothing else by script", () => {
    expect(PROD["connect-src"]).toEqual([
      "'self'",
      "https://project.supabase.co",
      "wss://project.supabase.co",
      "https://eu.i.posthog.com",
      "https://*.posthog.com",
    ]);
  });

  it("frames only YouTube players and Stripe's hosted pages", () => {
    expect(PROD["frame-src"]).toEqual([
      "'self'",
      "https://www.youtube-nocookie.com",
      "https://www.youtube.com",
      "https://js.stripe.com",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ]);
    // The OAuth consent form redirects to the client's registered URI, whatever its scheme.
    expect(PROD["form-action"]).toBeUndefined();
  });

  it("works with no PostHog, a proxied PostHog and a local Supabase", () => {
    const local = directives(buildCsp({ nonce: "n", supabaseUrl: "http://127.0.0.1:54321", posthogHost: "/ingest" }));
    expect(local["connect-src"]).toEqual(["'self'", "http://127.0.0.1:54321", "ws://127.0.0.1:54321"]);
    expect(local["img-src"]).toContain("http://127.0.0.1:54321");
    const bare = directives(buildCsp({ nonce: "n" }));
    expect(bare["connect-src"]).toEqual(["'self'"]);
  });

  it("adds eval and the HMR socket in development only", () => {
    const dev = directives(buildCsp({ nonce: "n", dev: true }));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(dev["connect-src"]).toEqual(expect.arrayContaining(["ws:", "wss:"]));
  });
});

describe("makeNonce", () => {
  it("is fresh, base64 and at least 128 bits", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

// ── The middleware sends it ────────────────────────────────────────────────

const getUser = vi.fn();
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser } }) }));

describe("middleware", () => {
  beforeEach(() => {
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  it("puts the policy on the response and the same nonce on the request Next renders from", async () => {
    const { middleware } = await import("@/middleware");
    const req = new NextRequest(new URL("/dashboard", "https://app.altorank.co"), { headers: { "x-nonce": "client-sent" } });
    const res = await middleware(req);
    const csp = res.headers.get("content-security-policy")!;
    const nonce = req.headers.get("x-nonce")!;
    expect(nonce).not.toBe("client-sent");
    expect(csp).toContain(`'nonce-${nonce}'`);
    // NextResponse.next forwards overridden request headers under this prefix.
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("sends a fresh nonce per request", async () => {
    const { middleware } = await import("@/middleware");
    const a = (await middleware(new NextRequest("https://app.altorank.co/dashboard"))).headers.get("content-security-policy");
    const b = (await middleware(new NextRequest("https://app.altorank.co/dashboard"))).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("sends it on a redirect to sign-in too", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const { middleware } = await import("@/middleware");
    const res = await middleware(new NextRequest("https://app.altorank.co/articles"));
    expect(res.status).toBe(307);
    expect(res.headers.get("content-security-policy")).toContain("'strict-dynamic'");
  });
});

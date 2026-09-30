// The routes around the handler: credentialed CORS on the answer and the
// preflight, the session read only for origins allowed to send one, and the
// widget's GET /me.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const viewerFromCookies = vi.fn();
vi.mock("@/lib/public-tools/viewer", () => ({ viewerFromCookies: () => viewerFromCookies() }));
const runsLeftToday = vi.fn();
vi.mock("@/lib/public-tools/user-runs", async (orig) => ({
  ...(await orig<typeof import("@/lib/public-tools/user-runs")>()),
  runsLeftToday: (id: string) => runsLeftToday(id),
}));

import { OPTIONS as toolOptions, POST as toolPost } from "../[slug]/route";
import { GET as meGet, OPTIONS as meOptions } from "../me/route";

const APP = "https://app.altorank.co";

function req(path: string, init: { method: string; origin?: string; body?: unknown }) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
  if (init.origin) headers.origin = init.origin;
  return new NextRequest(new URL(path, APP), {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

beforeEach(() => {
  viewerFromCookies.mockReset();
  runsLeftToday.mockReset();
});

describe("POST /api/public/tools/<slug>", () => {
  it("answers the preflight from altorank.co with credentials", async () => {
    const res = await toolOptions(req("/api/public/tools/seo-title-generator", { method: "OPTIONS", origin: "https://altorank.co" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://altorank.co");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("401s a paid tool with no session, with credentialed CORS on the error", async () => {
    viewerFromCookies.mockResolvedValue(null);
    const res = await toolPost(
      req("/api/public/tools/seo-title-generator", { method: "POST", origin: "https://www.altorank.co", body: { topic: "crm" } }),
      params("seo-title-generator"),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, code: "auth_required" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.altorank.co");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("does not read the session for a request from another site", async () => {
    viewerFromCookies.mockResolvedValue({ id: "u1", verified: true });
    const res = await toolPost(
      req("/api/public/tools/seo-title-generator", { method: "POST", origin: "https://evil.example", body: { topic: "crm" } }),
      params("seo-title-generator"),
    );
    expect(res.status).toBe(401);
    expect(viewerFromCookies).not.toHaveBeenCalled();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers email_unverified for a signed-in, unconfirmed account", async () => {
    viewerFromCookies.mockResolvedValue({ id: "u1", verified: false });
    const res = await toolPost(
      req("/api/public/tools/keyword-research", { method: "POST", origin: "https://altorank.co", body: { keyword: "crm", country: "us" } }),
      params("keyword-research"),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "email_unverified" });
  });

  it("never asks for a session on a fetch tool", async () => {
    const res = await toolPost(
      req("/api/public/tools/ai-crawler-simulator", { method: "POST", origin: "https://altorank.co", body: { url: "http://127.0.0.1/" } }),
      params("ai-crawler-simulator"),
    );
    // Refused by the schema (private address) - the point is it got there without a session.
    expect(res.status).toBe(400);
    expect(viewerFromCookies).not.toHaveBeenCalled();
  });
});

describe("GET /api/public/tools/me", () => {
  it("answers the preflight for GET with credentials", async () => {
    const res = await meOptions(req("/api/public/tools/me", { method: "OPTIONS", origin: "https://altorank.co" }));
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("signed out", async () => {
    viewerFromCookies.mockResolvedValue(null);
    const res = await meGet(req("/api/public/tools/me", { method: "GET", origin: "https://altorank.co" }));
    expect(await res.json()).toEqual({ signedIn: false });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("signed in, unverified", async () => {
    viewerFromCookies.mockResolvedValue({ id: "u1", verified: false });
    const res = await meGet(req("/api/public/tools/me", { method: "GET", origin: "https://altorank.co" }));
    expect(await res.json()).toEqual({ signedIn: true, verified: false });
    expect(runsLeftToday).not.toHaveBeenCalled();
  });

  it("verified, with the runs left and nothing else about the account", async () => {
    viewerFromCookies.mockResolvedValue({ id: "u1", verified: true });
    runsLeftToday.mockResolvedValue(2);
    const res = await meGet(req("/api/public/tools/me", { method: "GET", origin: "https://altorank.co" }));
    expect(await res.json()).toEqual({ signedIn: true, verified: true, remaining: 2, limit: 3 });
    expect(runsLeftToday).toHaveBeenCalledWith("u1");
  });

  it("reads no session for another site", async () => {
    viewerFromCookies.mockResolvedValue({ id: "u1", verified: true });
    const res = await meGet(req("/api/public/tools/me", { method: "GET", origin: "https://evil.example" }));
    expect(await res.json()).toEqual({ signedIn: false });
    expect(viewerFromCookies).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({ latestRun: vi.fn() }));
vi.mock("@/lib/onboarding/run-store", () => ({ latestRun: m.latestRun, startRun: vi.fn() }));
vi.mock("@/lib/billing/spend-gate", () => ({ canSpend: vi.fn() }));

import { firstLookView, storefrontLocked } from "../first-look";

const redirectTo = (location: string, status = 302) =>
  vi.fn(async () => new Response(null, { status, headers: { location } })) as unknown as typeof fetch;

const run = (over: Record<string, unknown> = {}) => ({
  run: {
    id: "r1",
    workspace_id: "ws",
    status: "partial",
    phases: [
      { phase: "scanning", status: "skipped", detail: "Too little readable text on the site to learn from." },
      { phase: "keywords", status: "skipped", detail: "No keywords." },
    ],
    planned: [],
    keywords_found: 0,
    article_id: null,
    error: null,
    started_at: "2026-10-16T10:00:00Z",
    updated_at: "2026-10-16T10:01:00Z",
    finished_at: "2026-10-16T10:01:00Z",
    ...over,
  },
  article: null,
  stale: false,
});

describe("storefrontLocked", () => {
  it("is true when the home page redirects to Shopify's password page", async () => {
    expect(await storefrontLocked("fern.myshopify.com", redirectTo("https://fern.myshopify.com/password"))).toBe(true);
  });
  it("is false for an open storefront, another redirect, or no answer", async () => {
    const ok = vi.fn(async () => new Response("<html/>", { status: 200 })) as unknown as typeof fetch;
    expect(await storefrontLocked("fern.myshopify.com", ok)).toBe(false);
    expect(await storefrontLocked("fern.myshopify.com", redirectTo("https://www.fern.com/"))).toBe(false);
    const down = vi.fn(async () => { throw new Error("ENOTFOUND"); }) as unknown as typeof fetch;
    expect(await storefrontLocked("fern.myshopify.com", down)).toBe(false);
  });
});

describe("firstLookView after a run that found nothing", () => {
  it("says the storefront is locked and how to unlock it", async () => {
    m.latestRun.mockResolvedValueOnce(run());
    const view = await firstLookView({} as never, "ws", {
      domain: "fern.myshopify.com",
      fetchImpl: redirectTo("https://fern.myshopify.com/password"),
    });
    expect(view).toMatchObject({ state: "empty", storefrontLocked: true });
    expect(view.message).toMatch(/password-protected/);
  });

  it("otherwise gives the first reason the run itself recorded", async () => {
    m.latestRun.mockResolvedValueOnce(run());
    const ok = vi.fn(async () => new Response("<html/>", { status: 200 })) as unknown as typeof fetch;
    expect(await firstLookView({} as never, "ws", { domain: "fern.myshopify.com", fetchImpl: ok })).toEqual({
      state: "empty",
      message: "Too little readable text on the site to learn from.",
    });
  });

  it("is done, with nothing to say, once something was planned", async () => {
    m.latestRun.mockResolvedValueOnce(run({ status: "done", planned: [{ keyword: "k" }] }));
    expect(await firstLookView({} as never, "ws", { domain: "fern.myshopify.com" })).toEqual({ state: "done", message: "" });
  });
});

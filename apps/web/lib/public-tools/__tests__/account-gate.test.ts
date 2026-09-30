// The paid kinds (`ai`, `data`) need a signed-in, verified account and count
// against that account's runs for the UTC day. What this file pins down is
// the ORDER, because each wrong order is a hole:
//
//   - the cache before the account check would hand a paid answer to anyone
//     who repeats an input somebody signed in already ran;
//   - counting on a cache hit charges a run for nothing;
//   - not giving the run back on our failure charges a run for nothing;
//   - treating an unreachable count as "no limit" is an open tab.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { handleToolRequest, userCapAnswer, type HandlerDeps } from "../handler";
import { defineTool } from "../types";
import { text } from "../blocks";
import { ToolError } from "../errors";
import { clearCache } from "../cache";
import type { AnyPublicTool } from "../registry";
import type { UserRunReservation } from "../user-runs";

let seq = 0;
function paidTool(over: Partial<AnyPublicTool> = {}): AnyPublicTool {
  return defineTool({
    slug: `paid${++seq}`,
    kind: "ai",
    input: z.object({ topic: z.string().min(1) }),
    perIpLimit: { limit: 50, windowMs: 60_000 },
    estimateCents: 3,
    run: async (input) => [text(`about ${input.topic}`)],
    ...over,
  }) as AnyPublicTool;
}

const body = (v: unknown) => async () => v;

function harness(tool: AnyPublicTool, over: Partial<HandlerDeps> = {}) {
  const calls: string[] = [];
  const getViewer = vi.fn(async () => {
    calls.push("viewer");
    return { id: "user-1", verified: true };
  });
  const reserveUserRun = vi.fn(async (): Promise<UserRunReservation> => {
    calls.push("user-run");
    return { ok: true, day: "2026-09-28", remaining: 2 };
  });
  const releaseUserRun = vi.fn(async () => {
    calls.push("release");
  });
  const reserveSpend = vi.fn(async () => {
    calls.push("spend");
    return true;
  });
  const deps: HandlerDeps = {
    getTool: (s) => (s === tool.slug ? tool : undefined),
    fetch: vi.fn(),
    getViewer,
    reserveUserRun,
    releaseUserRun,
    reserveSpend,
    ...over,
  };
  return { deps, calls, getViewer, reserveUserRun, releaseUserRun, reserveSpend };
}

beforeEach(() => clearCache());

describe("paid tools: who may run them", () => {
  it("401 auth_required with nobody signed in, before anything is reserved or run", async () => {
    const run = vi.fn(async () => [text("x")]);
    const t = paidTool({ run });
    const h = harness(t, { getViewer: async () => null });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, code: "auth_required" });
    expect(h.reserveUserRun).not.toHaveBeenCalled();
    expect(h.reserveSpend).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("401 when the route passes no session reader at all", async () => {
    const t = paidTool();
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", {
      getTool: () => t,
      fetch: vi.fn(),
    });
    expect(r.status).toBe(401);
  });

  it("403 email_unverified for a signed-in account whose email is not confirmed", async () => {
    const t = paidTool();
    const h = harness(t, { getViewer: async () => ({ id: "user-1", verified: false }) });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "email_unverified" });
    expect(h.reserveUserRun).not.toHaveBeenCalled();
  });

  it("checks the account BEFORE the cache: a cached paid answer is not served to a signed-out caller", async () => {
    const t = paidTool();
    const ok = harness(t);
    expect((await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", ok.deps)).status).toBe(200);
    const anon = harness(t, { getViewer: async () => null });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", anon.deps);
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toMatch(/about crm/);
  });

  it("validates the input before reading the session", async () => {
    const t = paidTool();
    const h = harness(t);
    const r = await handleToolRequest(t.slug, body({ topic: "" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(400);
    expect(h.getViewer).not.toHaveBeenCalled();
  });

  it("never reads the session for a fetch tool", async () => {
    const t = paidTool({ kind: "fetch", estimateCents: 0 });
    const h = harness(t);
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(200);
    expect(h.getViewer).not.toHaveBeenCalled();
    expect(h.reserveUserRun).not.toHaveBeenCalled();
    expect(h.reserveSpend).not.toHaveBeenCalled();
    expect(r.body).not.toHaveProperty("remaining");
  });
});

describe("paid tools: the account's daily runs", () => {
  it("runs in order viewer -> user run -> spend, and answers remaining", async () => {
    const t = paidTool();
    const h = harness(t);
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cached: false, remaining: 2 });
    expect(h.calls).toEqual(["viewer", "user-run", "spend"]);
    expect(h.reserveUserRun).toHaveBeenCalledWith("user-1");
    expect(h.releaseUserRun).not.toHaveBeenCalled();
  });

  it("a cache hit costs nothing: no run, no spend", async () => {
    const run = vi.fn(async () => [text("x")]);
    const t = paidTool({ run });
    const h = harness(t);
    await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    const second = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(second.body).toMatchObject({ ok: true, cached: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.reserveUserRun).toHaveBeenCalledTimes(1);
    expect(h.reserveSpend).toHaveBeenCalledTimes(1);
  });

  it("429 user_cap with the reset time and Retry-After, and nothing else reserved", async () => {
    const run = vi.fn(async () => [text("x")]);
    const t = paidTool({ run });
    const h = harness(t, {
      reserveUserRun: async () => ({ ok: false, reason: "cap" }),
      now: () => new Date("2026-09-28T21:00:00Z"),
    });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "user_cap" });
    expect((r.body as { error: string }).error).toMatch(/2026-09-29 00:00 UTC/);
    expect(r.headers["Retry-After"]).toBe(String(3 * 3600));
    expect(h.reserveSpend).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the count cannot be reached", async () => {
    const run = vi.fn(async () => [text("x")]);
    const t = paidTool({ run });
    const h = harness(t, { reserveUserRun: async () => ({ ok: false, reason: "error" }) });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "daily_cap" });
    expect(h.reserveSpend).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("gives the run back when the shared budget refuses", async () => {
    const t = paidTool();
    const h = harness(t, { reserveSpend: async () => false });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.body).toMatchObject({ code: "daily_cap" });
    expect(h.releaseUserRun).toHaveBeenCalledWith("user-1", "2026-09-28");
  });

  it("does not take a run when the per-IP limit refuses first", async () => {
    const t = paidTool({ perIpLimit: { limit: 1, windowMs: 60_000 } });
    const h = harness(t);
    await handleToolRequest(t.slug, body({ topic: "a" }), "9.9.9.1", h.deps);
    const r = await handleToolRequest(t.slug, body({ topic: "b" }), "9.9.9.1", h.deps);
    expect(r.body).toMatchObject({ code: "rate_limited" });
    expect(h.reserveUserRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["upstream", async () => { throw new ToolError("upstream", "Provider down."); }],
    ["unknown", async () => { throw new Error("bug"); }],
  ] as const)("gives the run back when the tool fails %s", async (code, run) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = paidTool({ run });
    const h = harness(t);
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.body).toMatchObject({ ok: false, code });
    expect(h.releaseUserRun).toHaveBeenCalledTimes(1);
    expect(h.releaseUserRun).toHaveBeenCalledWith("user-1", "2026-09-28");
  });

  it("gives the run back when the deadline passes", async () => {
    const t = paidTool({ run: () => new Promise(() => {}) });
    const h = harness(t, { deadlineMs: 20 });
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.body).toMatchObject({ code: "upstream" });
    expect(h.releaseUserRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the run when the tool itself refuses the input", async () => {
    const t = paidTool({ run: async () => { throw new ToolError("invalid_input", "That image is not public."); } });
    const h = harness(t);
    const r = await handleToolRequest(t.slug, body({ topic: "crm" }), "1.1.1.1", h.deps);
    expect(r.status).toBe(400);
    expect(h.releaseUserRun).not.toHaveBeenCalled();
  });
});

describe("userCapAnswer", () => {
  it("names the next UTC midnight and counts down to it", () => {
    const a = userCapAnswer(new Date("2026-09-28T23:59:30Z"), 3);
    expect(a.retryAfter).toBe(30);
    expect(a.message).toMatch(/3 free runs/);
    expect(a.message).toMatch(/2026-09-29 00:00 UTC, in 1 minute\)/);
    const b = userCapAnswer(new Date("2026-09-28T00:00:00Z"), 1);
    expect(b.retryAfter).toBe(24 * 3600);
    expect(b.message).toMatch(/1 free run of/);
    expect(b.message).toMatch(/in about 24 hours/);
  });
});

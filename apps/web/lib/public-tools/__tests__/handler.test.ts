import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { handleToolRequest } from "../handler";
import { defineTool } from "../types";
import { text } from "../blocks";
import { ToolError } from "../errors";
import { clearCache } from "../cache";
import { UnsafeUrlError, FetchFailedError } from "../safe-fetch";
import { publicUrl } from "../url";
import type { AnyPublicTool } from "../registry";

let seq = 0;
function makeTool(over: Partial<AnyPublicTool> = {}): AnyPublicTool {
  return defineTool({
    slug: `t${++seq}`,
    kind: "fetch",
    input: z.object({ url: publicUrl }),
    perIpLimit: { limit: 2, windowMs: 60_000 },
    estimateCents: 0,
    run: async (input) => [text(`ran ${input.url}`)],
    ...over,
  }) as AnyPublicTool;
}

const body = (v: unknown) => async () => v;
const deps = (tool: AnyPublicTool, extra: Record<string, unknown> = {}) => ({
  getTool: (s: string) => (s === tool.slug ? tool : undefined),
  fetch: vi.fn(),
  ...extra,
});

beforeEach(() => clearCache());

describe("handleToolRequest", () => {
  it("404s an unknown slug", async () => {
    const t = makeTool();
    const r = await handleToolRequest("nope", body({}), "1.1.1.1", deps(t));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, code: "not_found" });
  });

  it("400s a body that is not JSON", async () => {
    const t = makeTool();
    const r = await handleToolRequest(t.slug, async () => { throw new SyntaxError("bad"); }, "1.1.1.1", deps(t));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_input" });
  });

  it("400s input that fails the schema, with the schema's sentence", async () => {
    const t = makeTool();
    const r = await handleToolRequest(t.slug, body({ url: "http://127.0.0.1/" }), "1.1.1.1", deps(t));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "invalid_input" });
    expect((r.body as { error: string }).error).toMatch(/private or local/);
  });

  it("runs, normalises the URL, and answers the second identical call from cache", async () => {
    const run = vi.fn(async (input: { url: string }) => [text(input.url)]);
    const t = makeTool({ run });
    const a = await handleToolRequest(t.slug, body({ url: "example.com" }), "1.1.1.1", deps(t));
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ ok: true, data: { blocks: [{ type: "text", text: "https://example.com/" }] }, cached: false });
    const b = await handleToolRequest(t.slug, body({ url: "https://example.com/" }), "1.1.1.1", deps(t));
    expect(b.body).toMatchObject({ ok: true, cached: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rate-limits fresh runs per IP per tool, with Retry-After", async () => {
    const t = makeTool();
    for (const u of ["a.com", "b.com"]) {
      expect((await handleToolRequest(t.slug, body({ url: u }), "2.2.2.2", deps(t))).status).toBe(200);
    }
    const r = await handleToolRequest(t.slug, body({ url: "c.com" }), "2.2.2.2", deps(t));
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "rate_limited" });
    expect(r.headers["Retry-After"]).toBeDefined();
    // Another IP is unaffected.
    expect((await handleToolRequest(t.slug, body({ url: "c.com" }), "3.3.3.3", deps(t))).status).toBe(200);
  });

  it("never reserves spend for a fetch tool", async () => {
    const reserveSpend = vi.fn(async () => false);
    const t = makeTool();
    const r = await handleToolRequest(t.slug, body({ url: "a.com" }), "4.4.4.4", deps(t, { reserveSpend }));
    expect(r.status).toBe(200);
    expect(reserveSpend).not.toHaveBeenCalled();
  });

  it("reserves spend for a paid tool and answers daily_cap when refused", async () => {
    const run = vi.fn(async () => [text("x")]);
    const t = makeTool({ kind: "ai", estimateCents: 2, run });
    const reserveSpend = vi.fn(async () => false);
    const r = await handleToolRequest(t.slug, body({ url: "a.com" }), "5.5.5.5", deps(t, { reserveSpend }));
    expect(reserveSpend).toHaveBeenCalledWith(t.slug, 2);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: "daily_cap" });
    expect((r.body as { error: string }).error).toMatch(/resting until tomorrow/);
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a ToolError to its code and status", async () => {
    const t = makeTool({ run: async () => { throw new ToolError("upstream", "The site is down."); } });
    const r = await handleToolRequest(t.slug, body({ url: "a.com" }), "6.6.6.6", deps(t));
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ ok: false, error: "The site is down.", code: "upstream" });
  });

  it("maps escaped fetch errors: unsafe -> 400, failed -> 502", async () => {
    const a = makeTool({ run: async () => { throw new UnsafeUrlError("x resolves to a private address"); } });
    expect((await handleToolRequest(a.slug, body({ url: "a.com" }), "7.7.7.7", deps(a))).status).toBe(400);
    const b = makeTool({ run: async () => { throw new FetchFailedError("timed out", "https://a.com/"); } });
    expect((await handleToolRequest(b.slug, body({ url: "a.com" }), "7.7.7.7", deps(b))).status).toBe(502);
  });

  it("answers an unexpected throw as unknown without leaking the message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = makeTool({ run: async () => { throw new Error("SUPABASE_SERVICE_ROLE_KEY=secret"); } });
    const r = await handleToolRequest(t.slug, body({ url: "a.com" }), "8.8.8.8", deps(t));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/secret/);
    spy.mockRestore();
  });

  it("enforces the deadline and aborts the tool's signal", async () => {
    let signal: AbortSignal | undefined;
    const t = makeTool({
      run: (_i, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    });
    const r = await handleToolRequest(t.slug, body({ url: "a.com" }), "9.9.9.9", { ...deps(t), deadlineMs: 20 });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ code: "upstream" });
    expect(signal?.aborted).toBe(true);
  });
});

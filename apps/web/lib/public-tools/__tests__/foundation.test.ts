import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";

vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { parsePublicUrl } from "../url";
import { reserveSpend, dailyCapCents } from "../spend";
import { askHaiku, askHaikuJson, extractJson, MAX_OUTPUT_TOKENS } from "../ai";
import { dataforseoLive } from "../data";
import { ToolError } from "../errors";
import { listTools } from "../registry";

afterEach(() => vi.unstubAllEnvs());

describe("parsePublicUrl", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["  https://Example.com/a?b=1#frag ", "https://example.com/a?b=1"],
    ["//example.com/x", "https://example.com/x"],
    ["http://www.example.com", "http://www.example.com/"],
  ])("%s -> %s", (raw, out) => {
    expect(parsePublicUrl(raw)).toEqual({ ok: true, url: out });
  });

  it.each([
    ["", /Enter a web address/],
    ["javascript:alert(1)", /Only http and https/],
    ["mailto:a@b.com", /Only http and https/],
    ["http://localhost:3000", /Port 3000|private or local/],
    ["http://10.0.0.1/", /private or local/],
    ["http://printer.local/", /private or local/],
    ["https://intranet.corp/", /not a public site/],
    ["not a url at all", /does not look like a web address/],
  ])("refuses %s", (raw, msg) => {
    const r = parsePublicUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe("reserveSpend", () => {
  const client = (result: { data: unknown; error: { message: string } | null } | Error) => ({
    rpc: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  });

  it("passes tool, estimate and the env cap to the RPC", async () => {
    vi.stubEnv("PUBLIC_TOOLS_DAILY_CAP_CENTS", "250");
    const c = client({ data: true, error: null });
    expect(await reserveSpend("x", 3, c)).toBe(true);
    expect(c.rpc).toHaveBeenCalledWith("reserve_public_tool_spend", { p_tool: "x", p_estimate_cents: 3, p_cap_cents: 250 });
  });

  it("defaults the cap to 500 and ignores junk", () => {
    expect(dailyCapCents()).toBe(500);
    vi.stubEnv("PUBLIC_TOOLS_DAILY_CAP_CENTS", "lots");
    expect(dailyCapCents()).toBe(500);
  });

  it("is false when the cap is reached", async () => {
    expect(await reserveSpend("x", 3, client({ data: false, error: null }))).toBe(false);
  });

  it("FAILS CLOSED on an RPC error, a throw, or no client", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await reserveSpend("x", 3, client({ data: null, error: { message: "function does not exist" } }))).toBe(false);
    expect(await reserveSpend("x", 3, client(new Error("network")))).toBe(false);
    expect(await reserveSpend("x", 3, null)).toBe(false);
    spy.mockRestore();
  });
});

describe("ai helpers", () => {
  const fakeClient = (textOut: string, stop = "end_turn") => ({
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: "text", text: textOut }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: stop,
      })),
    },
  });

  it("extractJson tolerates fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
    expect(() => extractJson("no json here")).toThrow();
  });

  it("pins the Haiku model and caps max_tokens", async () => {
    vi.stubEnv("ANTHROPIC_MODEL", "some-large-model");
    const c = fakeClient("hello");
    const r = await askHaiku({ tool: "t", system: "s", user: "u", maxTokens: 999_999, client: c as never });
    expect(r.text).toBe("hello");
    const args = (c.messages.create.mock.calls[0] as unknown[])[0] as { model: string; max_tokens: number };
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("askHaikuJson validates against the schema; a miss is upstream", async () => {
    const schema = z.object({ ideas: z.array(z.string()) });
    const ok = await askHaikuJson({ tool: "t", system: "s", user: "u", schema, client: fakeClient('{"ideas":["a"]}') as never });
    expect(ok.data.ideas).toEqual(["a"]);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      askHaikuJson({ tool: "t", system: "s", user: "u", schema, client: fakeClient('{"ideas":"a"}') as never }),
    ).rejects.toMatchObject({ code: "upstream" });
    await expect(
      askHaikuJson({ tool: "t", system: "s", user: "u", schema, client: fakeClient('{"ideas":["a"', "max_tokens") as never }),
    ).rejects.toBeInstanceOf(ToolError);
    spy.mockRestore();
  });

  it("maps a provider failure and a missing key to upstream", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { messages: { create: vi.fn(async () => { throw new Error("529 overloaded"); }) } };
    await expect(askHaiku({ tool: "t", system: "s", user: "u", client: broken as never })).rejects.toMatchObject({ code: "upstream" });
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(askHaiku({ tool: "t", system: "s", user: "u" })).rejects.toMatchObject({ code: "upstream" });
    spy.mockRestore();
  });
});

describe("dataforseoLive", () => {
  it("returns the first task's rows", async () => {
    const post = vi.fn(async () => ({ tasks: [{ result: [{ k: 1 }] }] }));
    expect(await dataforseoLive("t", "/x/live", { a: 1 }, { post: post as never })).toEqual([{ k: 1 }]);
    expect(post).toHaveBeenCalledWith("/x/live", [{ a: 1 }], { maxAttempts: undefined });
  });

  it("maps a provider error to upstream", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const post = vi.fn(async () => { throw new Error("40201 suspended"); });
    await expect(dataforseoLive("t", "/x/live", {}, { post: post as never })).rejects.toMatchObject({ code: "upstream" });
    spy.mockRestore();
  });

  it("refuses queued endpoints", async () => {
    await expect(dataforseoLive("t", "/x/task_post", {}, { post: vi.fn() as never })).rejects.toThrow(/live endpoints only/);
  });
});

describe("registry", () => {
  it("has unique slugs and free fetch tools", () => {
    const tools = listTools();
    expect(new Set(tools.map((t) => t.slug)).size).toBe(tools.length);
    for (const t of tools) if (t.kind === "fetch") expect(t.estimateCents).toBe(0);
  });
});

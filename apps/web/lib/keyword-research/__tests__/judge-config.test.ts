import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptsThinkingDisabled, anthropicModel, DECISION_CALL, MODEL_DEFAULTS } from "@/lib/ai/models";
import { askStructured, samplingFor } from "../buyer-model";
import { askedKey, BUYER_FIT_MAX_TOKENS, BUYER_FIT_SCHEMA, judgeBuyerFit, savedFitFor, SEARCH_STAGES } from "../buyer-fit";
import { ANTHROPIC_RATES } from "@/lib/billing/spend";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

afterEach(() => { vi.unstubAllEnvs(); create.mockReset(); });

describe("how a topic decision is asked", () => {
  it("puts both judges on Sonnet 5 through one tier, and the rest on Haiku", () => {
    expect(DECISION_CALL.tier).toBe("decision");
    expect(MODEL_DEFAULTS.anthropicDecision).toBe("claude-sonnet-5");
    expect(anthropicModel("decision")).toBe("claude-sonnet-5");
    expect(anthropicModel("structured")).toBe("claude-haiku-4-5-20251001");
  });
  it("sends temperature 0 where a model takes one, thinking off where it does not, and the reply schema", () => {
    const schema = { type: "object" };
    expect(samplingFor("claude-haiku-4-5-20251001", "decision", schema)).toEqual({ temperature: 0, output_config: { format: { type: "json_schema", schema } } });
    // Sonnet 5 answers 400 to any temperature (2026-09-30).
    expect(samplingFor("claude-sonnet-5", "decision", schema)).toEqual({ thinking: { type: "disabled" }, output_config: { format: { type: "json_schema", schema } } });
    expect(samplingFor("claude-sonnet-5", "decision")).toEqual({ thinking: { type: "disabled" } });
    // The cheap tier gets temperature 0 alone: no schema, thinking untouched.
    expect(samplingFor("claude-haiku-4-5-20251001", "structured", schema)).toEqual({ temperature: 0 });
    expect(samplingFor("claude-sonnet-5", "structured")).toEqual({});
  });
  it("sends thinking-disabled only to models known to take it, and leaves it out for the rest", () => {
    for (const model of ["claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7"]) expect(acceptsThinkingDisabled(model), model).toBe(true);
    // Opus 5.5 and the Fable/Mythos models answer "disabled" with a 400.
    for (const model of ["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(acceptsThinkingDisabled(model), model).toBe(false);
      expect(samplingFor(model, "decision")).toEqual({});
    }
  });
  it("gives a self-hoster's one pinned model to the decisions too, unless the decision model is set", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-opus-5");
    expect(anthropicModel("decision")).toBe("claude-opus-5");
    vi.stubEnv("ANTHROPIC_MODEL_DECISION", "claude-sonnet-5");
    expect(anthropicModel("decision")).toBe("claude-sonnet-5");
  });
  it("says why a call failed instead of returning a silent null", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockRejectedValue(Object.assign(new Error("thinking: disabled is not supported"), { status: 400 }));
    expect(await askStructured("keyword-research/opportunity", "prompt", { maxTokens: 10, tier: "decision" })).toBeNull();
    expect(warn.mock.calls[0][0]).toContain("(400)");
    warn.mockRestore();
  });
  it("makes the request production makes, on the real path", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockResolvedValue({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
    await askStructured("op", "prompt", { maxTokens: 10, tier: "decision", schema: { type: "object" } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-sonnet-5", thinking: { type: "disabled" }, output_config: { format: { type: "json_schema", schema: { type: "object" } } } }));
    expect(create.mock.calls[0][0]).not.toHaveProperty("temperature");
  });
  it("gives the buyer test room for a full batch and holds its stage to the known stages", async () => {
    expect(BUYER_FIT_MAX_TOKENS).toBe(8000);
    const items = ((BUYER_FIT_SCHEMA.properties as Record<string, { items: { properties: { s: { enum: string[] } } } }>).verdicts).items;
    expect(items.properties.s.enum).toEqual([...SEARCH_STAGES]);
    const ask = vi.fn(async () => JSON.stringify({ verdicts: [{ t: "brakes", s: "problem", r: "driver" }] }));
    const out = await judgeBuyerFit({ description: "A garage" }, ["brakes"], { ask });
    expect(out.verdicts.get("brakes")).toMatchObject({ keep: true, funnel: "audience", asked: askedKey({ description: "A garage" }) });
    expect(ask).toHaveBeenCalledWith("keyword-research/buyer-fit", expect.any(String), expect.objectContaining({ maxTokens: 8000, tier: "decision", schema: BUYER_FIT_SCHEMA }));
  });
  it("reuses a saved buyer verdict only when it answers the question asked now", () => {
    const business = { description: "A garage", language: "en" };
    const saved = { keep: true, reason: "driver", funnel: "buyer", asked: askedKey(business) };
    expect(savedFitFor(saved, business)).toEqual(saved);
    expect(savedFitFor(saved, { ...business, language: "tr" })).toBeNull();
    expect(savedFitFor({ keep: true, reason: "driver" }, business)).toBeNull();
    expect(savedFitFor(null, business)).toBeNull();
  });
  it("prices Sonnet 5 at its published $2/$10", () => {
    expect(ANTHROPIC_RATES["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  anthropicModel,
  openaiModel,
  openaiImageModel,
  MODEL_DEFAULTS,
} from "../models";

const VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_MODEL_STRUCTURED",
  "OPENAI_MODEL",
  "OPENAI_IMAGE_MODEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("model defaults", () => {
  it("uses the current Claude generation for content", () => {
    expect(anthropicModel("content")).toBe(MODEL_DEFAULTS.anthropicContent);
  });

  it("defaults content when no tier is given", () => {
    expect(anthropicModel()).toBe(MODEL_DEFAULTS.anthropicContent);
  });

  it("does not silently downgrade structured work to a smaller model", () => {
    // The tier exists as a cost lever, but opting in must be explicit:
    // defaulting it lower would change brief and cluster output as a
    // side effect of a refactor that only meant to remove duplication.
    expect(anthropicModel("structured")).toBe(anthropicModel("content"));
  });

  it("carries no stale pinned date-suffixed id", () => {
    expect(MODEL_DEFAULTS.anthropicContent).not.toContain("20250514");
  });
});

describe("environment overrides", () => {
  it("ANTHROPIC_MODEL overrides both tiers", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    expect(anthropicModel("content")).toBe("claude-opus-5");
    expect(anthropicModel("structured")).toBe("claude-opus-5");
  });

  it("ANTHROPIC_MODEL_STRUCTURED narrows the structured tier only", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    process.env.ANTHROPIC_MODEL_STRUCTURED = "claude-haiku-4-5-20251001";
    expect(anthropicModel("content")).toBe("claude-opus-5");
    expect(anthropicModel("structured")).toBe("claude-haiku-4-5-20251001");
  });

  it("applies the structured override even with no general override", () => {
    process.env.ANTHROPIC_MODEL_STRUCTURED = "claude-haiku-4-5-20251001";
    expect(anthropicModel("content")).toBe(MODEL_DEFAULTS.anthropicContent);
    expect(anthropicModel("structured")).toBe("claude-haiku-4-5-20251001");
  });

  it("overrides the OpenAI chat and image models independently", () => {
    process.env.OPENAI_MODEL = "gpt-4.1";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1";
    expect(openaiModel()).toBe("gpt-4.1");
    expect(openaiImageModel()).toBe("gpt-image-1");
  });

  it("is read per call, so a runtime env change takes effect without a rebuild", () => {
    expect(anthropicModel()).toBe(MODEL_DEFAULTS.anthropicContent);
    process.env.ANTHROPIC_MODEL = "claude-opus-5";
    expect(anthropicModel()).toBe("claude-opus-5");
  });
});

describe("malformed environment values", () => {
  it("falls back when the variable is set but empty", () => {
    process.env.ANTHROPIC_MODEL = "";
    expect(anthropicModel()).toBe(MODEL_DEFAULTS.anthropicContent);
  });

  it("falls back when the variable is only whitespace", () => {
    // A blank line in a .env file is the common way this happens, and an
    // empty model id produces a confusing 400 from the API rather than a
    // recognisable configuration error.
    process.env.ANTHROPIC_MODEL = "   ";
    expect(anthropicModel()).toBe(MODEL_DEFAULTS.anthropicContent);
  });

  it("trims surrounding whitespace rather than passing it through", () => {
    process.env.OPENAI_MODEL = "  gpt-4.1  ";
    expect(openaiModel()).toBe("gpt-4.1");
  });
});

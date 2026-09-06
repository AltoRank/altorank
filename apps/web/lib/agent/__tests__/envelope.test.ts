import { describe, expect, it } from "vitest";
import { ERROR_STATUS, fail, HUMAN_PRESENTATION_RULES, ok, valueLabel } from "../envelope";

describe("ok", () => {
  it("wraps data with guidance and nothing else by default", () => {
    const env = ok({ a: 1 }, "Next, do B.");
    expect(env).toEqual({ ok: true, data: { a: 1 }, agent_guidance: "Next, do B." });
    expect("_human" in env).toBe(false);
    expect("_meta" in env).toBe(false);
  });

  it("fills _meta defaults so every settings-like response carries the rules", () => {
    const env = ok({}, "g", { _meta: { writeable_fields: ["name"] } });
    expect(env._meta).toEqual({
      writeable_fields: ["name"],
      hidden_from_human_summary_fields: [],
      human_presentation_rules: [...HUMAN_PRESENTATION_RULES],
    });
  });

  it("keeps a _human block verbatim", () => {
    const human = { title: "T", summary_instructions: "S", sections: [] };
    expect(ok(null, "g", { _human: human })._human).toBe(human);
  });
});

describe("fail", () => {
  it("has the failure shape and no data key", () => {
    const env = fail("unauthorized", "Revoked.", "Ask for a new key.");
    expect(env).toEqual({
      ok: false,
      error: { code: "unauthorized", message: "Revoked." },
      agent_guidance: "Ask for a new key.",
    });
    expect("data" in env).toBe(false);
  });

  it("maps every code to an HTTP status", () => {
    for (const code of Object.keys(ERROR_STATUS) as (keyof typeof ERROR_STATUS)[]) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });
});

describe("valueLabel", () => {
  it("renders unknown as an em dash, never 0", () => {
    expect(valueLabel(null)).toBe("—");
    expect(valueLabel(undefined)).toBe("—");
    expect(valueLabel("")).toBe("—");
    expect(valueLabel(0)).toBe("0");
    expect(valueLabel(42, "%")).toBe("42%");
    expect(valueLabel(true)).toBe("Yes");
  });
});

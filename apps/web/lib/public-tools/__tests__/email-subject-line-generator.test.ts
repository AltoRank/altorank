import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, tableOf } from "./paid-helpers";
import { emailSubjectLineGenerator as tool, subjectNotes } from "../tools/email-subject-line-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


describe("email-subject-line-generator", () => {
  it("shows character counts and drops fake replies", async () => {
    create.mockResolvedValue(
      answer({
        subject_lines: [
          { subject: "Your spring price change", preview: "What changes and when" },
          { subject: "Re: your account", preview: "x" },
          { subject: "FWD: pricing", preview: "x" },
        ],
      }),
    );
    const blocks = await tool.run(tool.input.parse({ topic: "spring price change" }), ctx());
    const t = tableOf(blocks);
    expect(t.rows).toEqual([["Your spring price change", 24, "What changes and when", ""]]);
  });

  it("notes long, shouting and exclamation-heavy lines", () => {
    expect(subjectNotes("A subject line that is definitely longer than forty characters")).toMatch(/cut on phones/);
    expect(subjectNotes("HUGE news")).toMatch(/all-caps/);
    expect(subjectNotes("Now!!")).toMatch(/exclamation/);
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the topic", () => {
    expect(issue(tool.input, { topic: "t".repeat(201) })).toMatch(/under 200/);
  });
});

import { describe, it, expect, vi } from "vitest";

// A stream that ends at the ceiling: some article text, then stop_reason
// max_tokens with the usage the API reports.
const events = [
  { type: "content_block_delta", delta: { type: "text_delta", text: "<h1>Half</h1><p>of an article" } },
  { type: "message_delta", usage: { output_tokens: 24_000 } },
];
const finalMessage = { stop_reason: "max_tokens", usage: { input_tokens: 5_824, output_tokens: 24_000 } };
const streamCall = vi.fn(() => ({
  [Symbol.asyncIterator]: async function* () {
    for (const e of events) yield e;
  },
  finalMessage: async () => finalMessage,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: streamCall };
  },
}));

import { ClaudeProvider, GenerationTruncatedError } from "../claude";

describe("ClaudeProvider at the token ceiling", () => {
  it("throws an error that carries the billed usage instead of a bare message", async () => {
    const provider = new ClaudeProvider("claude-sonnet-5");
    const gen = provider.streamArticle({ keyword: "seo marketing content" });
    let err: unknown;
    try {
      for await (const _chunk of gen) {
        // drain
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GenerationTruncatedError);
    const t = err as GenerationTruncatedError;
    expect(t.inputTokens).toBe(5_824);
    expect(t.outputTokens).toBe(24_000);
    expect(t.chars).toBe("<h1>Half</h1><p>of an article".length);
    expect(t.message).toContain("hit the token ceiling after 24000 output tokens");
  });

  it("asks for a ceiling that clears a heavy thinking run plus a long article", () => {
    const provider = new ClaudeProvider("claude-sonnet-5");
    void provider.streamArticle({ keyword: "x" }).next();
    const calls = streamCall.mock.calls as unknown as Array<[{ max_tokens: number; model: string }]>;
    const params = calls.at(-1)?.[0];
    expect(params?.model).toBe("claude-sonnet-5");
    expect(params?.max_tokens).toBeGreaterThanOrEqual(64_000);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/billing/default-spend", () => ({ recordSpendByDefault: vi.fn(), spendClient: () => null }));

import { answer, ctx, quiet, issue, kvOf, codeOf, item } from "./paid-helpers";
import { aiArticleGenerator as tool } from "../tools/ai-article-generator";

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  create.mockReset();
});
afterEach(() => vi.unstubAllEnvs());


const DRAFT = "# Apartment Composting Made Simple\n\nOpening.\n\n## Pick a method\n\n[Add: your own example of a bin]\n";

describe("ai-article-generator", () => {
  it("returns the draft as Markdown with its checks", async () => {
    create.mockResolvedValue(answer("```markdown\n" + DRAFT + "```"));
    const blocks = await tool.run(tool.input.parse({ topic: "composting in a flat", keyword: "apartment composting" }), ctx());
    const [md] = codeOf(blocks);
    expect(md.language).toBe("markdown");
    expect(md.code.startsWith("# Apartment Composting")).toBe(true);
    const k = kvOf(blocks);
    expect(item(k, "Keyword in title")?.value).toBe("yes");
    expect(item(k, "Places to add your own facts")?.value).toBe("1");
    expect(item(k, "Sources")?.status).toBe("warn");
  });

  it("is upstream when the model returns nothing", async () => {
    create.mockResolvedValue(answer(""));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
  });

  it("maps a model failure to upstream", async () => {
    const restore = quiet();
    create.mockRejectedValue(new Error("529 overloaded"));
    await expect(tool.run(tool.input.parse({ topic: "x" }), ctx())).rejects.toMatchObject({ code: "upstream" });
    restore();
  });

  it("validates the fields", () => {
    expect(issue(tool.input, { topic: "" })).toMatch(/Enter a topic/);
  });
});

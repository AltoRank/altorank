import { beforeEach, describe, expect, it, vi } from "vitest";
const ask = vi.hoisted(() => vi.fn());
vi.mock("@/lib/keyword-research/buyer-model", async (original) => ({
  ...await original<typeof import("@/lib/keyword-research/buyer-model")>(), askStructured: ask,
}));
import { selectArticleQuestions } from "../article-questions";

const questions = ["Can ChatGPT do therapy?", "What is the 2 year rule in therapy?", "How much does a therapist website cost?"];
const context = {
  keyword: "therapy practice website", language: "English",
  business: { description: "Website design and booking integration for private practices", audiences: ["Practice owners"] },
  brief: { audience: "Therapy practice owners", buyingJob: "Choose a website and booking setup", offering: "Website design", angle: "Therapy practice website costs and booking options" },
};
beforeEach(() => ask.mockReset());

describe("article question qualification", () => {
  it("only passes affirmative decisions for the original questions and gives the judge the buying context", async () => {
    ask.mockResolvedValue(JSON.stringify([
      { id: 0, keep: false, reason: "Clinical advice, unrelated to buying a website" },
      { id: 1, keep: false, reason: "Clinical ethics, wrong task" },
      { id: 2, keep: true, reason: "Budgeting a practice website" },
      { id: 99, keep: true, reason: "Invented question" },
    ]));
    const result = await selectArticleQuestions(questions, context);
    expect(result.kept).toEqual([questions[2]]);
    expect(result.status).toBe("qualified");
    expect(result.decisions).toHaveLength(3);
    expect(ask.mock.calls[0][1]).toContain(context.brief.buyingJob);
    expect(ask.mock.calls[0][1]).toContain(context.business.description);
  });

  it.each([null, "not JSON", '[{"id":0,"keep":"yes","reason":"x"}]', '[{"id":0,"keep":true}]'])
    ("omits raw PAA on missing or malformed decisions: %s", async (response) => {
      ask.mockResolvedValue(response);
      const result = await selectArticleQuestions(questions, context);
      expect(result.status).toBe("unavailable");
      expect(result.kept).toEqual([]);
    });

  it("does not interpret omissions or duplicate decisions as approval", async () => {
    ask.mockResolvedValue('[{"id":0,"keep":true,"reason":"x"},{"id":0,"keep":false,"reason":"y"},{"id":2,"keep":true,"reason":"cost"}]');
    const result = await selectArticleQuestions(questions, context);
    expect(result.status).toBe("partial");
    expect(result.kept).toEqual([questions[2]]);
  });

  it("skips empty input and bounds each qualification to ten distinct questions", async () => {
    expect((await selectArticleQuestions([], context)).status).toBe("empty");
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValue(null);
    const result = await selectArticleQuestions([...questions, ...questions, ...Array.from({ length: 20 }, (_, i) => `Question ${i}?`)], context);
    expect(result.decisions).toHaveLength(10);
  });
});

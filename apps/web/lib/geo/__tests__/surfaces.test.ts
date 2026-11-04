import { describe, it, expect } from "vitest";
import { buildTask, isStillQueued, parseSurfaceResult, taskGetPath, taskPostPath } from "../surfaces";
import { spendOperation } from "@/lib/seo/client";
import { estimateDataForSEOUsd } from "@/lib/seo/dataforseo-cost";

describe("surface endpoints", () => {
  it("queues every surface on the standard queue, at $0.0012 a task", () => {
    for (const s of ["chat_gpt", "gemini", "google_ai_mode"] as const) {
      const task = buildTask({ prompt: "best seo tool", languageCode: "en", locationCode: 2840, tag: "row-1" });
      expect(task.priority).toBe(1);
      expect(estimateDataForSEOUsd(taskPostPath(s), [task])).toBeCloseTo(0.0012, 6);
    }
  });

  it("files every collected task under one spend operation, not one per id", () => {
    const id = "11051234-1535-0216-0000-5a1b2c3d4e5f";
    expect(spendOperation(taskGetPath("chat_gpt", id))).toBe("/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/{id}");
    expect(spendOperation(taskGetPath("google_ai_mode", id))).toBe("/serp/google/ai_mode/task_get/advanced/{id}");
  });

  it("does not force ChatGPT to search: a buyer's ChatGPT decides for itself", () => {
    expect(buildTask({ prompt: "x", languageCode: "en", locationCode: 2840, tag: "t" })).not.toHaveProperty("force_web_search");
  });
});

describe("parseSurfaceResult", () => {
  it("reads the ChatGPT app's answer, sources, entities and fan-out", () => {
    const a = parseSurfaceResult("chat_gpt", {
      model: "gpt-5",
      markdown: "**Surfer** and **Frase** are popular.",
      sources: [
        { url: "https://www.rankability.com/blog/x", domain: "www.rankability.com", title: "Best tools" },
        { url: "https://www.rankability.com/blog/x", domain: "www.rankability.com", title: "dupe" },
      ],
      fan_out_queries: ["best seo content tools 2026"],
      brand_entities: [{ title: "Surfer" }, { title: "Frase" }, { title: "Surfer" }],
    })!;
    expect(a.model).toBe("gpt-5");
    expect(a.citations).toEqual([{ title: "Best tools", url: "https://www.rankability.com/blog/x", domain: "rankability.com" }]);
    expect(a.brands).toEqual(["Surfer", "Frase"]);
    expect(a.fanOutQueries).toEqual(["best seo content tools 2026"]);
  });

  it("reads Google AI Mode's answer and every nested reference and link", () => {
    const a = parseSurfaceResult("google_ai_mode", {
      items: [
        { type: "organic", markdown: "not the answer" },
        {
          type: "ai_overview",
          markdown: "AltoRank writes drafts.",
          references: [{ url: "https://altorank.co/", domain: "altorank.co", title: "AltoRank" }],
          items: [{ type: "ai_overview_element", links: [{ url: "https://g2.com/x", domain: "g2.com", title: "G2" }] }],
        },
      ],
    })!;
    expect(a.answer).toBe("AltoRank writes drafts.");
    expect(a.citations.map((c) => c.domain)).toEqual(["altorank.co", "g2.com"]);
  });

  it("calls an answer with no text a failed sample, not an answer that named nobody", () => {
    expect(parseSurfaceResult("google_ai_mode", { items: [{ type: "organic" }] })).toBeNull();
    expect(parseSurfaceResult("chat_gpt", { markdown: "  " })).toBeNull();
    expect(parseSurfaceResult("gemini", null)).toBeNull();
  });

  it("treats Task Handed and Task in Queue as not ready, everything else as final", () => {
    expect(isStillQueued(40601)).toBe(true);
    expect(isStillQueued(40602)).toBe(true);
    expect(isStillQueued(40201)).toBe(false);
  });
});

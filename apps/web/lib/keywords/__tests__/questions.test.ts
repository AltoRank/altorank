import { describe, it, expect } from "vitest";
import { parseQuestionBatch, parseStoredQuestions, toQualityQuestions, unansweredCount } from "../questions";

const terms = ["open source seo tools", "How To Rank"];

describe("parseQuestionBatch", () => {
  it("reads a clean reply keyed by term", () => {
    const raw = JSON.stringify({
      "open source seo tools": [
        "Which open-source SEO tool is a staple in your toolkit?",
        "Can you share a real example of how you used it to fix an SEO issue?",
        "What modifications have you made to the raw codebase?",
        "How do you contribute back to the open-source SEO community?",
      ],
      "how to rank": ["What was the first page you ranked, and how long did it take?", "What did you change that moved it?"],
    });
    const out = parseQuestionBatch(raw, terms);
    expect(out.get("open source seo tools")).toHaveLength(4);
    // Key matching ignores case: the model echoes terms in its own casing.
    expect(out.get("How To Rank")).toHaveLength(2);
  });
  it("tolerates a code fence and a sentence of preamble", () => {
    const raw = 'Here you go:\n```json\n{"open source seo tools": ["Which tool do you rely on daily?", "What did it fix for you last month?"]}\n```';
    expect(parseQuestionBatch(raw, terms).get("open source seo tools")).toHaveLength(2);
  });
  it("returns nothing for junk, never a fabricated question", () => {
    expect(parseQuestionBatch("I cannot help with that.", terms).size).toBe(0);
    expect(parseQuestionBatch("[1,2,3]", terms).size).toBe(0);
    expect(parseQuestionBatch('{"open source seo tools": "one string"}', terms).size).toBe(0);
    // One usable question is not a questionnaire.
    expect(parseQuestionBatch('{"open source seo tools": ["Only one real question here?", "", 7]}', terms).size).toBe(0);
  });
  it("caps at four and drops non-strings", () => {
    const raw = JSON.stringify({ "open source seo tools": ["Question number one?", null, "Question number two?", "Question number three?", "Question number four?", "Question number five?"] });
    const qs = parseQuestionBatch(raw, terms).get("open source seo tools")!;
    expect(qs).toHaveLength(4);
    expect(qs[3]).toBe("Question number four?");
  });
});

describe("stored questions", () => {
  it("wraps strings as unanswered rows with stable ids", () => {
    const qs = toQualityQuestions(["A?", "B?"]);
    expect(qs).toEqual([{ id: "q1", question: "A?", answer: null }, { id: "q2", question: "B?", answer: null }]);
    expect(unansweredCount(qs)).toBe(2);
  });
  it("reads a jsonb column defensively", () => {
    expect(parseStoredQuestions(null)).toEqual([]);
    expect(parseStoredQuestions("nope")).toEqual([]);
    const qs = parseStoredQuestions([
      { id: "q1", question: "A?", answer: "  " },
      { question: "B?", answer: "We use Screaming Frog." },
      { id: "q3", question: "" },
      42,
    ]);
    expect(qs).toEqual([
      { id: "q1", question: "A?", answer: null },
      { id: "q2", question: "B?", answer: "We use Screaming Frog." },
    ]);
    expect(unansweredCount(qs)).toBe(1);
  });
});

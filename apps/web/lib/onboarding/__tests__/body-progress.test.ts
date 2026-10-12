import { describe, expect, it } from "vitest";
import { measureStream, readBodyProgress, sectionsDone } from "../body-progress";

describe("the first body's progress, counts only", () => {
  it("counts the H2s started and the words, not the writer's title or meta description", () => {
    const html = "<h1>A title of six words here</h1><meta-description>Not counted at all.</meta-description><p>One two three.</p><h2>Key takeaways</h2><ul><li>Four five</li></ul><h2>Next sec";
    expect(measureStream(html)).toEqual({ sections: 2, words: 9 });
    expect(measureStream("")).toEqual({ sections: 0, words: 0 });
  });

  it("ticks every section before the one being written, the closing one only once saved", () => {
    // Outline: 4 sections and a closing heading.
    expect(sectionsDone({ stage: "thinking", sections: 0 }, 5, { done: false, hasClosing: true })).toEqual([]);
    expect(sectionsDone({ stage: "writing", sections: 1 }, 5, { done: false, hasClosing: true })).toEqual([]);
    expect(sectionsDone({ stage: "writing", sections: 3 }, 5, { done: false, hasClosing: true })).toEqual([0, 1]);
    // A writer that opened more H2s than the outline has still leaves the closing heading to enrichment.
    expect(sectionsDone({ stage: "writing", sections: 9 }, 5, { done: false, hasClosing: true })).toEqual([0, 1, 2, 3]);
    expect(sectionsDone({ stage: "finishing", sections: 4 }, 5, { done: false, hasClosing: true })).toEqual([0, 1, 2, 3]);
    expect(sectionsDone({ stage: "finishing", sections: 4 }, 4, { done: false, hasClosing: false })).toEqual([0, 1, 2, 3]);
    expect(sectionsDone(null, 5, { done: true, hasClosing: true })).toEqual([0, 1, 2, 3, 4]);
    expect(sectionsDone(null, 5, { done: false, hasClosing: true })).toEqual([]);
  });

  it("reads only a record it wrote", () => {
    expect(readBodyProgress({ v: 1, stage: "writing", since: "2026-10-12T00:00:00Z", sections: 2, words: 10.7 })).toEqual({ v: 1, stage: "writing", since: "2026-10-12T00:00:00Z", sections: 2, words: 10 });
    expect(readBodyProgress({ v: 2, stage: "writing", since: "x" })).toBeNull();
    expect(readBodyProgress({ v: 1, stage: "typing", since: "x" })).toBeNull();
    expect(readBodyProgress(null)).toBeNull();
  });
});

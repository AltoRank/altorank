import { describe, expect, it } from "vitest";
import {
  compare,
  comparisonText,
  containment,
  CONTAINMENT_MATCH,
  CONTAINMENT_WITH_TITLE,
  foldWord,
  isMatch,
  prepareDraft,
  preparePage,
  shinglesOf,
  SHINGLE,
  titleSimilarity,
  wordsOf,
} from "../similarity";
import * as F from "./fixtures";

// The threshold is picked from these fixtures, and this file is the record of
// that choice. Containment of the draft's word runs in each page, measured
// while choosing (draft words: Turkish 362, English 474):
//
//                    kept in order   k=3     k=4     k=5
//   tr copy              0.78       0.687   0.656   0.628
//   tr same outline      0.14       0.031   0.017   0.008
//   tr unrelated         0.01       0.000   0.000   0.000
//   en copy              0.79       0.740   0.715   0.694
//   en same outline      0.18       0.028   0.013   0.002
//   en unrelated         0.07       0.000   0.000   0.000
//
// Four words per run: at three, stock phrases shared by any two articles on a
// topic start to count; at five and up, every edited word costs the copy more
// runs while the same-outline pages are already at zero. At four the lightly
// edited copies sit above 0.65 and the same-outline pages below 0.02, and
// CONTAINMENT_MATCH = 0.5 sits between them with room on both sides.

/** Longest common subsequence of words, as a share of the draft: "how much was kept, in order". */
function keptInOrder(draft: string[], page: string[]): number {
  let prev = new Array<number>(page.length + 1).fill(0);
  for (let i = 1; i <= draft.length; i++) {
    const cur = new Array<number>(page.length + 1).fill(0);
    for (let j = 1; j <= page.length; j++) {
      cur[j] = draft[i - 1] === page[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[page.length] / draft.length;
}

const words = (html: string) => wordsOf(comparisonText(html));
const h1Of = (html: string) => html.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? null;
const titleOf = (html: string) => html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null;

function score(draft: F.FixtureDraft, page: string) {
  return compare(prepareDraft(draft.title, F.draftHtml(draft)), preparePage(page, [titleOf(page), h1Of(page)]));
}

describe("the fixtures are what they claim to be", () => {
  // If a fixture drifts, the threshold test below stops meaning anything.
  it.each([
    ["Turkish", F.TR_DRAFT, F.TR_COPY_PAGE],
    ["English", F.EN_DRAFT, F.EN_COPY_PAGE],
  ])("the %s copy keeps about 80%% of the draft's words, in order", (_, draft, page) => {
    const kept = keptInOrder(words(F.draftHtml(draft)), words(page));
    expect(kept).toBeGreaterThan(0.75);
    expect(kept).toBeLessThan(0.85);
  });

  it.each([
    ["Turkish", F.TR_DRAFT, F.TR_SAME_OUTLINE_PAGE],
    ["English", F.EN_DRAFT, F.EN_SAME_OUTLINE_PAGE],
  ])("the %s same-outline page has the draft's title and every heading, word for word", (_, draft, page) => {
    expect(h1Of(page)).toBe(draft.title);
    for (const s of draft.sections) expect(page).toContain(`<h2>${s.heading}</h2>`);
  });

  it("the copies translate every heading", () => {
    for (const s of F.TR_DRAFT.sections) expect(F.TR_COPY_PAGE).not.toContain(`<h2>${s.heading}</h2>`);
    for (const s of F.EN_DRAFT.sections) expect(F.EN_COPY_PAGE).not.toContain(`<h2>${s.heading}</h2>`);
  });
});

describe("compare", () => {
  it("matches the lightly edited Turkish copy on its text alone", () => {
    const e = score(F.TR_DRAFT, F.TR_COPY_PAGE);
    expect(e.containment).toBeGreaterThanOrEqual(CONTAINMENT_MATCH);
    expect(e.rule).toBe("text");
    expect(isMatch(e)).toBe(true);
  });

  it("matches the lightly edited English copy on its text alone", () => {
    const e = score(F.EN_DRAFT, F.EN_COPY_PAGE);
    expect(e.containment).toBeGreaterThanOrEqual(CONTAINMENT_MATCH);
    expect(isMatch(e)).toBe(true);
  });

  it.each([
    ["Turkish", F.TR_DRAFT, F.TR_SAME_OUTLINE_PAGE],
    ["English", F.EN_DRAFT, F.EN_SAME_OUTLINE_PAGE],
  ])("does not match a %s article with the same title and outline but different prose", (_, draft, page) => {
    const e = score(draft, page);
    // The title is identical - which is exactly why it cannot decide alone.
    expect(e.title).toBe(1);
    expect(e.containment).toBeLessThan(CONTAINMENT_WITH_TITLE / 5);
    expect(e.rule).toBe("none");
    expect(isMatch(e)).toBe(false);
  });

  it.each([
    ["Turkish", F.TR_DRAFT],
    ["English", F.EN_DRAFT],
  ])("does not match an unrelated page against the %s draft", (_, draft) => {
    const e = score(draft, F.UNRELATED_PAGE);
    expect(e.containment).toBe(0);
    expect(isMatch(e)).toBe(false);
  });

  it("uses the title to accept a heavier edit published under our headline", () => {
    // Keep the intro and two of six sections: containment lands between the
    // two thresholds, and the title decides.
    const d = F.EN_DRAFT;
    const half = { ...d, sections: d.sections.slice(0, 2), cta: "" };
    const page = F.sitePage({ lang: "en", title: d.title, h1: d.title, body: F.draftHtml(half) });
    const e = score(d, page);
    expect(e.containment).toBeGreaterThanOrEqual(CONTAINMENT_WITH_TITLE);
    expect(e.containment).toBeLessThan(CONTAINMENT_MATCH);
    expect(e.rule).toBe("text+title");

    const retitled = F.sitePage({ lang: "en", title: "Something else entirely", h1: "Something else entirely", body: F.draftHtml(half) });
    expect(score(d, retitled).rule).toBe("none");
  });

  it("refuses to judge a draft too short to be evidence", () => {
    const tiny = { title: "Kısa", intro: "Bu çok kısa bir taslak.", sections: [], cta: "" };
    const e = compare(prepareDraft(tiny.title, F.draftHtml(tiny)), preparePage(F.draftHtml(tiny), [tiny.title]));
    expect(e.rule).toBe("too-short");
    expect(isMatch(e)).toBe(false);
  });

  it("ignores the page's chrome: containment is of the draft in the page, not the other way round", () => {
    const bare = score(F.TR_DRAFT, F.TR_COPY_BODY);
    const framed = score(F.TR_DRAFT, F.TR_COPY_PAGE);
    expect(framed.containment).toBe(bare.containment);
  });
});

describe("words", () => {
  it("folds case, diacritics and dotless i the same way on both sides", () => {
    expect(foldWord("İSTANBUL")).toBe(foldWord("istanbul"));
    expect(foldWord("ılık")).toBe(foldWord("ILIK"));
    expect(foldWord("Dükkanı")).toBe("dukkani");
    expect(foldWord("ŞİŞLİ")).toBe(foldWord("şişli"));
  });

  it("does not let an apostrophe, straight or curly, split or change a word", () => {
    expect(wordsOf("İstanbul’da ve İstanbul'da")).toEqual(["istanbulda", "ve", "istanbulda"]);
    expect(wordsOf("don't stop")).toEqual(["dont", "stop"]);
  });

  it("joins a word that inline markup split, as a copy without links would read it", () => {
    expect(wordsOf(comparisonText("<p><a href='/x'>İstanbul</a>’da <strong>bir</strong>gün</p>"))).toEqual([
      "istanbulda",
      "birgun",
    ]);
    expect(wordsOf(comparisonText("<p>bir</p><p>gün</p>"))).toEqual(["bir", "gun"]);
  });

  it("segments a script written without spaces into words", () => {
    // ICU's dictionary breaks Japanese into words; a regex on spaces would
    // see one word and no shingles at all.
    expect(wordsOf("東京は晴れです").length).toBeGreaterThan(1);
  });

  it("drops scripts, styles and the head", () => {
    const t = comparisonText("<head><title>x</title></head><body><script>var a=1</script><style>p{}</style><p>kept</p></body>");
    expect(t).toBe("kept");
  });

  it("shingles are runs of SHINGLE words and containment is over the inner set", () => {
    const s = shinglesOf(["a", "b", "c", "d", "e"]);
    expect(SHINGLE).toBe(4);
    expect([...s]).toEqual(["a b c d", "b c d e"]);
    expect(containment(s, new Set(["a b c d"]))).toBe(0.5);
    expect(containment(new Set(), s)).toBe(0);
  });

  it("title similarity is word-set overlap, and absent means no evidence", () => {
    expect(titleSimilarity("A Guide to Desks", "desks: a guide TO")).toBe(1);
    expect(titleSimilarity("A Guide to Desks", null)).toBe(0);
    expect(titleSimilarity("", "anything")).toBe(0);
  });
});

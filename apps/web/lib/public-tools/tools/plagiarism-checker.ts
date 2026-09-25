// ---------------------------------------------------------------------------
// Plagiarism checker: a spot check of distinctive sentences against Google
// ---------------------------------------------------------------------------
//
// Exactly what the page says it does, and nothing more:
//   1. pick up to 5 distinctive sentences from the pasted text (the longest
//      ones that are not boilerplate, cut to 30 words because Google ignores
//      words after the 32nd);
//   2. run each as an exact-phrase ("quoted") Google search through
//      DataForSEO's live SERP endpoint, first page only;
//   3. report, per sentence, the pages Google returned, and whether Google's
//      snippet for each page visibly contains the phrase.
// Paraphrase, the unchecked sentences and unindexed pages are not covered,
// and the output says so.
//
// Pasted text is not cached (cacheTtlMs: 0). Only the chosen sentences leave
// the server, as search queries; the form's note says the same.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { ToolError } from "../errors";
import { kv, table, text, type Block, type KvItem } from "../blocks";
import { pastedText } from "../fields";

const SLUG = "plagiarism-checker";
export const MAX_SENTENCES = 5;
const MIN_WORDS = 8;
const MAX_QUERY_WORDS = 30;

const BOILERPLATE =
  /(https?:\/\/|www\.|@[a-z0-9-]+\.|all rights reserved|copyright|©|cookie|privacy policy|terms of (use|service)|click here|subscribe|sign up|newsletter|share this|read more)/i;

/** Sentences of the text, whitespace collapsed. */
export function splitSentences(s: string): string[] {
  return s
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?…])["'”’)]?\s+(?=["'“‘(]?[\p{Lu}\p{N}])/u)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The phrase to search: quotes removed (they would break the exact-phrase query), at most 30 words. */
export function toPhrase(sentence: string): string {
  const words = sentence.replace(/["“”„«»]/g, "").replace(/\s+/g, " ").trim().split(" ");
  return words
    .slice(0, MAX_QUERY_WORDS)
    .join(" ")
    .replace(/[.!?…,;:]+$/, "");
}

/** Up to five distinctive sentences, returned in the order they appear in the text. */
export function pickSentences(s: string): string[] {
  const candidates = splitSentences(s)
    .map((sentence, index) => ({ sentence, index, words: sentence.split(" ").length }))
    .filter((c) => c.words >= MIN_WORDS && !BOILERPLATE.test(c.sentence))
    .filter((c) => (c.sentence.match(/\p{L}/gu) ?? []).length >= c.sentence.length * 0.6);
  const seen = new Set<string>();
  const chosen = [...candidates]
    .sort((a, b) => b.sentence.length - a.sentence.length)
    .filter((c) => {
      const k = toPhrase(c.sentence).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_SENTENCES);
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.sentence);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whether a snippet shows the phrase: at least 10 consecutive words of it
 * (all of it, if shorter). Snippets are cut, so a shorter run proves little.
 */
export function snippetShows(snippet: string | null | undefined, phrase: string): boolean {
  if (!snippet) return false;
  const hay = norm(snippet);
  const words = norm(phrase).split(" ");
  const n = Math.min(10, words.length);
  for (let i = 0; i + n <= words.length; i++) {
    if (hay.includes(words.slice(i, i + n).join(" "))) return true;
  }
  return false;
}

interface SerpItem {
  type: string;
  url?: string;
  domain?: string;
  title?: string;
  description?: string | null;
}
interface SerpResult {
  items?: SerpItem[] | null;
}

export const plagiarismChecker = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({ text: pastedText() }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Up to five live regular SERP calls, first page each, with headroom for retried faults.
  estimateCents: 2,
  cacheTtlMs: 0,
  async run({ text: source }) {
    const sentences = pickSentences(source);
    if (!sentences.length) {
      throw new ToolError("invalid_input", `Paste at least one full sentence of ${MIN_WORDS} words or more; shorter phrases match too much of the web to mean anything.`);
    }
    const phrases = sentences.map(toPhrase);

    const results = await Promise.allSettled(
      phrases.map((phrase) =>
        dataforseoLive<SerpResult>(
          SLUG,
          "/serp/google/organic/live/regular",
          {
            keyword: `"${phrase}"`,
            location_code: 2840,
            language_code: "en",
            depth: 10,
          },
          // An exact phrase Google has no page for comes back as 40101, the
          // status DataForSEO also uses for a transient fault. For original
          // text that is the usual answer, so it reads as "none" here, and it
          // is not retried: parallel live SERP calls queue for up to ~20s each
          // on their side, and three attempts overran the route's deadline.
          { maxAttempts: 1, emptyOnStatus: [40101] },
        ),
      ),
    );
    if (results.every((r) => r.status === "rejected")) {
      throw new ToolError("upstream", "The web searches behind this check failed. Try again in a minute.");
    }

    // Google relaxes a quoted query it has no exact match for and returns
    // loosely related pages instead, so a result is only evidence when its
    // snippet shows the phrase. The rest are listed apart, never counted.
    const LOOSE_PER_SENTENCE = 3;
    const summaryRows: (string | number)[][] = [];
    const matchRows: (string | number)[][] = [];
    const looseRows: (string | number)[][] = [];
    let found = 0;
    let failed = 0;
    let looseOnly = 0;
    results.forEach((r, i) => {
      const n = i + 1;
      if (r.status === "rejected") {
        failed++;
        summaryRows.push([n, phrases[i], "search failed"]);
        return;
      }
      const pages = (r.value[0]?.items ?? []).filter((it) => it.type === "organic" && it.url);
      const shown = pages.filter((p) => snippetShows(p.description, phrases[i]));
      const loose = pages.filter((p) => !snippetShows(p.description, phrases[i]));
      if (shown.length) found++;
      else if (loose.length) looseOnly++;
      const plural = (k: number) => `${k} page${k === 1 ? "" : "s"}`;
      summaryRows.push([
        n,
        phrases[i],
        shown.length
          ? `${plural(shown.length)} showing it${loose.length ? `, ${loose.length} other` : ""}`
          : loose.length
            ? `no page showing it (${loose.length} loose result${loose.length === 1 ? "" : "s"})`
            : "none",
      ]);
      for (const p of shown) matchRows.push([n, p.url!, p.title ?? ""]);
      for (const p of loose.slice(0, LOOSE_PER_SENTENCE)) looseRows.push([n, p.url!, p.title ?? ""]);
    });

    const checked = sentences.length - failed;
    const items: KvItem[] = [
      { label: "Sentences checked", value: `${checked} of ${sentences.length} chosen`, status: failed ? "warn" : "info" },
      {
        label: "Found on other pages",
        value: found ? `${found} of ${checked} sentence${checked === 1 ? "" : "s"}` : "none of the checked sentences",
        status: found ? "warn" : "pass",
      },
    ];
    if (looseOnly) {
      items.push({
        label: "Loose results only",
        value: `${looseOnly} sentence${looseOnly === 1 ? "" : "s"}: Google returned pages, but none shows the words`,
        status: "info",
      });
    }
    const blocks: Block[] = [
      kv(items, "Exact-phrase spot check"),
      table(["#", "Searched as (exact phrase)", "Google results"], summaryRows, "Sentences checked"),
    ];
    if (matchRows.length) {
      blocks.push(table(["Sentence #", "Page", "Title"], matchRows, "Pages whose Google snippet shows the phrase"));
    }
    if (looseRows.length) {
      blocks.push(table(["Sentence #", "Page", "Title"], looseRows, "Other pages Google returned (the phrase is not in their snippet)"));
    }
    blocks.push(
      text(
        `The tool picked up to ${MAX_SENTENCES} of your longest, most distinctive sentences and ran each as an exact-phrase Google search (United States, first page of results) through DataForSEO. A sentence counts as found only when Google's snippet for a page shows at least 10 of its words in a row; open the page to confirm. When Google has no exact match it often returns loosely related pages instead, so those are listed apart and not counted. A match is not proof of copying: it may be a credited quote, a common phrase, or a copy of your text. The rest of the text, reworded copying, pages Google has not indexed and copies the snippet does not show were not checked.`,
        "What this checked",
      ),
    );
    return blocks;
  },
});

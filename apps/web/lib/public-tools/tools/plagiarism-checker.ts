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
        dataforseoLive<SerpResult>(SLUG, "/serp/google/organic/live/regular", {
          keyword: `"${phrase}"`,
          location_code: 2840,
          language_code: "en",
          depth: 10,
        }),
      ),
    );
    if (results.every((r) => r.status === "rejected")) {
      throw new ToolError("upstream", "The web searches behind this check failed. Try again in a minute.");
    }

    const summaryRows: (string | number)[][] = [];
    const matchRows: (string | number)[][] = [];
    let found = 0;
    let failed = 0;
    results.forEach((r, i) => {
      const n = i + 1;
      if (r.status === "rejected") {
        failed++;
        summaryRows.push([n, phrases[i], "search failed"]);
        return;
      }
      const pages = (r.value[0]?.items ?? []).filter((it) => it.type === "organic" && it.url);
      if (pages.length) found++;
      summaryRows.push([n, phrases[i], pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"}` : "none"]);
      for (const p of pages) matchRows.push([n, p.url!, p.title ?? "", snippetShows(p.description, phrases[i]) ? "yes" : "not shown"]);
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
    const blocks: Block[] = [
      kv(items, "Exact-phrase spot check"),
      table(["#", "Searched as (exact phrase)", "Google results"], summaryRows, "Sentences checked"),
    ];
    if (matchRows.length) {
      blocks.push(table(["Sentence #", "Page", "Title", "Snippet shows the phrase"], matchRows, "Pages Google returned for the exact phrase"));
    }
    blocks.push(
      text(
        `The tool picked up to ${MAX_SENTENCES} of your longest, most distinctive sentences and ran each as an exact-phrase Google search (United States, first page of results) through DataForSEO. It lists the pages Google returned, and whether Google's snippet for each shows at least 10 words of the phrase in a row; open a page to confirm. A match is not proof of copying: it may be a credited quote, a common phrase, or a copy of your text. No match means these sentences were not found word for word; the rest of the text, reworded copying and pages Google has not indexed were not checked.`,
        "What this checked",
      ),
    );
    return blocks;
  },
});

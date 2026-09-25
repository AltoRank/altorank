// ---------------------------------------------------------------------------
// Blog post ideas from real searches
// ---------------------------------------------------------------------------
//
// Every idea is a search someone ran. Two DataForSEO Labs keyword_suggestions
// calls in parallel (United States, English: the form has no country field):
//   - questions: suggestions that start with a question word;
//   - long-tail: the most-searched suggestions, whatever their shape.
// Near-duplicate phrasings ("how to start composting at home" / "how to
// start home composting") are merged into one idea with the others listed,
// because they are one post. No model is involved: the page promises the
// ideas trace back to real searches, and the privacy note on the form says
// the topic goes to DataForSEO only.

import { z } from "zod";
import { defineTool } from "../types";
import { dataforseoLive } from "../data";
import { ToolError } from "../errors";
import { kv, table, text, type Block } from "../blocks";
import { requiredText } from "../fields";
import { COUNTRIES } from "../locations";
import { byVolumeDesc, dedupeRows, toRow, type KeywordRow, type LabsSuggestionsResult } from "../labs";

const SLUG = "blog-post-ideas";
const QUESTION_WORDS = ["how", "what", "why", "when", "where", "which", "who", "can", "does", "do", "is", "are", "should", "will"];
const QUESTION_RE = new RegExp(`^(${QUESTION_WORDS.join("|")})\\s`, "i");
export const MAX_IDEAS = 40;

const STOP = new Set(["a", "an", "the", "to", "for", "of", "in", "on", "at", "and", "or", "i", "you", "my", "your", "do", "does", "is", "are", "it", "with", "can", "be"]);

/** One key for phrasings of the same need: content words, singular, sorted. */
export function ideaKey(keyword: string): string {
  const words = keyword
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(" ");
}

export function questionGroup(keyword: string): string {
  const first = keyword.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (["how", "what", "why", "when", "where", "which", "who"].includes(first)) return `${first[0].toUpperCase()}${first.slice(1)} questions`;
  if (QUESTION_WORDS.includes(first)) return "Yes/no questions";
  return "Other searches";
}

export interface Idea {
  idea: string;
  group: string;
  volume: number | null;
  variants: string[];
}

/** Merge near-duplicates; the most-searched phrasing names the idea. */
export function groupIdeas(rows: KeywordRow[]): Idea[] {
  const byKey = new Map<string, KeywordRow[]>();
  for (const r of [...rows].sort(byVolumeDesc)) {
    const k = ideaKey(r.keyword);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const ideas = [...byKey.values()].map(([top, ...rest]) => ({
    idea: QUESTION_RE.test(top.keyword) ? `${top.keyword[0].toUpperCase()}${top.keyword.slice(1)}?` : top.keyword,
    group: questionGroup(top.keyword),
    volume: top.volume,
    variants: rest.map((r) => r.keyword).slice(0, 3),
  }));
  const order = (g: string) => (g === "Other searches" ? 2 : g === "Yes/no questions" ? 1 : 0);
  return ideas.sort((a, b) => order(a.group) - order(b.group) || (b.volume ?? -1) - (a.volume ?? -1));
}

export const blogPostIdeas = defineTool({
  slug: SLUG,
  kind: "data",
  input: z.object({ topic: requiredText("a topic", 200) }),
  perIpLimit: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Two keyword_suggestions calls of <=50 rows each, with headroom.
  estimateCents: 5,
  async run({ topic }) {
    const loc = COUNTRIES.us;
    const base = {
      keyword: topic.toLowerCase(),
      location_code: loc.locationCode,
      language_code: loc.languageCode,
      limit: 50,
      order_by: ["keyword_info.search_volume,desc"],
    };
    const [questions, longTail] = await Promise.allSettled([
      dataforseoLive<LabsSuggestionsResult>(SLUG, "/dataforseo_labs/google/keyword_suggestions/live", {
        ...base,
        filters: ["keyword", "regex", `^(${QUESTION_WORDS.join("|")}) `],
      }),
      dataforseoLive<LabsSuggestionsResult>(SLUG, "/dataforseo_labs/google/keyword_suggestions/live", base),
    ]);
    if (questions.status === "rejected" && longTail.status === "rejected") {
      throw questions.reason instanceof ToolError ? questions.reason : new ToolError("upstream", "The search data is unavailable right now. Try again later.");
    }
    const rows = dedupeRows(
      [questions, longTail].flatMap((r) => (r.status === "fulfilled" ? (r.value[0]?.items ?? []).map(toRow) : [])),
    ).filter((r) => r.keyword.toLowerCase() !== topic.toLowerCase());

    if (!rows.length) {
      return [
        text(
          `No searches containing "${topic}" were found in the United States data. Try a shorter or more common phrasing, for example the main noun on its own.`,
          "No ideas found",
        ),
      ];
    }

    const ideas = groupIdeas(rows).slice(0, MAX_IDEAS);
    const questionCount = ideas.filter((i) => i.group !== "Other searches").length;
    const blocks: Block[] = [
      kv(
        [
          { label: "Searches found", value: String(rows.length), status: "info" },
          { label: "Post ideas after merging near-duplicates", value: String(ideas.length), status: "info" },
          { label: "Question searches", value: String(questionCount), status: "info" },
        ],
        `Ideas for "${topic}"`,
      ),
      table(
        ["Post idea (the search)", "Type", "Monthly searches", "Also searched as"],
        ideas.map((i) => [i.idea, i.group, i.volume, i.variants.join("; ")]),
        "Post ideas from real searches",
      ),
    ];
    if (questions.status === "rejected" || longTail.status === "rejected") {
      blocks.push(text("One of the two lookups failed, so this list is shorter than usual. Run it again for the full set.", "Partial result"));
    }
    blocks.push(
      text(
        "Each idea is a search people run in the United States, from DataForSEO's third-party data. Monthly searches are modelled estimates for the most-searched phrasing; long questions often show low or no volume and can still be worth a post. Cover near-duplicates on one page.",
        "About these ideas",
      ),
    );
    return blocks;
  },
});

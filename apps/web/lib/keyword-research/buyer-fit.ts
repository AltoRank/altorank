// ---------------------------------------------------------------------------
// Would this business's buyer search that? One call over the whole list
// ---------------------------------------------------------------------------
//
// Every filter the first look grew between 2026-09-02 and 2026-09-10 was a
// patch for one bad article: twelve string-shape rules, a word-overlap
// relevance score, a commercial-fit heuristic. Each catches the last mistake
// and misses the next one, because a wrong-but-clean keyword like "ups
// shipping calculator" passes all of them for a warehouse app.
//
// This asks the question directly. Given the profile the person confirmed and
// up to `MAX_JUDGED` candidate phrases, the model says for each whether the
// person typing it is plausibly someone this business can sell to or help,
// and why not when not. It is one call on the cheap tier, so it can run on a
// pool that already exists as well as on new research - which is how a plan
// filled before this existed gets re-checked.
//
// With no model the verdict is "unjudged" for every term, and the caller
// keeps the heuristics it had.

import type { SpendSink } from "./buyer-model";
import { askStructured, describeBusiness, extractJson, modelAvailable } from "./buyer-model";

/** Enough for a first look's whole pool; more would be a second call. */
export const MAX_JUDGED = 150;

export type FitVerdict = { keep: true; reason: string | null } | { keep: false; reason: string };

export interface FitJudgement {
  /** Term (lower-cased) to verdict. A term the model did not answer for is absent. */
  verdicts: Map<string, FitVerdict>;
  basis: "model" | "none";
}

export interface FitProfile {
  name?: string | null;
  description?: string | null;
  audiences?: string[] | null;
  offerings?: string[] | null;
  competitors?: string[] | null;
}

const PROMPT = [
  "You are checking keyword candidates for a business's blog. The blog exists to be found by people who might buy from",
  "this business or need what it does. For each phrase decide: is the person typing it into Google plausibly someone",
  "this business can sell to or help?",
  "",
  "Reject a phrase when:",
  "- the searcher wants a consumer tool, calculator or lookup this business does not provide (a warehouse app is not a postage calculator);",
  "- the searcher has decided NOT to buy this kind of product (\"free\", \"without software\", \"do it yourself\" when the business sells the software);",
  "- it names another company or product rather than a need;",
  "- it is a one-word or generic head term with no product intent, or belongs to a different industry that merely shares a word;",
  "- it is in a language the business does not serve.",
  "",
  "Keep a phrase when it is the product category, a problem the product solves, a comparison or alternative search,",
  "or a how-to question this business's buyer asks while doing their job.",
  "",
  "Return ONLY a JSON array, no prose, no code fence, one object per phrase in the order given:",
  '[{"t":"<phrase exactly as given>","k":true|false,"r":"<reason, 12 words or fewer, empty when kept>"}]',
].join("\n");

/** Exported for tests: the reply, folded onto the terms that were asked. */
export function parseVerdicts(raw: string | null, asked: readonly string[]): Map<string, FitVerdict> {
  const out = new Map<string, FitVerdict>();
  const arr = extractJson<unknown>(raw, "[", "]");
  if (!Array.isArray(arr)) return out;
  const askedSet = new Set(asked.map((t) => t.trim().toLowerCase()));
  for (const v of arr) {
    if (!v || typeof v !== "object") continue;
    const o = v as { t?: unknown; k?: unknown; r?: unknown };
    const term = typeof o.t === "string" ? o.t.trim().toLowerCase() : "";
    if (!term || !askedSet.has(term) || typeof o.k !== "boolean") continue;
    const reason = typeof o.r === "string" && o.r.trim() ? o.r.trim() : null;
    out.set(term, o.k ? { keep: true, reason } : { keep: false, reason: reason ?? "not a search this business's buyer makes" });
  }
  return out;
}

export async function judgeBuyerFit(
  business: FitProfile | null,
  terms: readonly string[],
  options: { spend?: SpendSink | null } = {},
): Promise<FitJudgement> {
  const asked = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_JUDGED);
  const described = business ? describeBusiness(business) : "";
  if (!asked.length || !described || !modelAvailable()) return { verdicts: new Map(), basis: "none" };
  const prompt = `${PROMPT}\n\nBUSINESS\n${described}\n\nPHRASES\n${JSON.stringify(asked)}`;
  // ~25 tokens a verdict; the cap is for the reply, not the phrases.
  const raw = await askStructured("keyword-research/buyer-fit", prompt, { maxTokens: 4000, spend: options.spend });
  const verdicts = parseVerdicts(raw, asked);
  return { verdicts, basis: verdicts.size ? "model" : "none" };
}

// ---------------------------------------------------------------------------
// Model IDs, in one place
// ---------------------------------------------------------------------------
//
// These used to be nine separate string literals across lib/ai, lib/tools and
// lib/seo/exchange.ts. Every one of them said `claude-sonnet-4-20250514`, and
// they drifted independently: bumping a model meant finding all nine, and
// missing one left a feature silently a generation behind.
//
// Every tier is env-overridable, which matters more here than in a normal app:
// the $0 self-host rung is BYOK, and a self-hoster may have access to a
// different model set than the hosted service. Overriding a model must not
// require editing source.
//
// Resolved per call rather than captured at import, so a deployment that sets
// these at runtime does not need a rebuild to take effect.

/**
 * What the model is being asked to do, not how big it is.
 *
 * Naming tiers by purpose rather than by size ("fast", "smart") means the
 * mapping can change without every call site becoming a lie.
 */
export type ModelTier =
  /** Long-form writing and analysis, where output quality is the product. */
  | "content"
  /** Short structured work: meta descriptions, clustering, SERP summaries. */
  | "structured"
  /**
   * The topic decisions: is this searcher someone the business serves, and
   * what are the results for a search. The buyer test (lib/keyword-research/
   * buyer-fit.ts) and the results judge (lib/keyword-research/opportunity.ts)
   * and nothing else. Measured on the labelled decision eval (2026-09-30):
   * Haiku at its default temperature flipped the same topic between runs;
   * these calls decide whether a customer gets any plan at all. Asked as
   * `DECISION_CALL` says.
   *
   * Everything else short and structured stays on `structured` (Haiku): the
   * buyer seeds, the rival vetting, the planned topics' questions. Those
   * propose or annotate; a code rule or a later decision checks them, so a
   * cheap classifier is enough there.
   */
  | "decision";

/**
 * How a topic decision is asked, in one place: the model tier and the
 * sampling. Read by `samplingFor` (lib/keyword-research/buyer-model.ts) for
 * production and by the decision evals, so the two cannot drift.
 *
 * - `temperature: 0` is sent to every model that takes one. claude-sonnet-5
 *   does not: it answers 400 "`temperature` is deprecated for this model"
 *   (measured 2026-09-30), as do the other current Sonnet/Opus/Fable models.
 *   For those, determinism comes from the rest of this setting.
 * - `thinking: "disabled"`: a decision is a classification, not a problem to
 *   reason through, and a thinking-off answer is cheaper and steadier.
 * - `structuredOutput: true`: the reply is constrained to the caller's JSON
 *   schema, stage and kind as enums, so a model that starts to reason in its
 *   visible text ("<think>...", seen on Sonnet 5 with thinking off) cannot
 *   produce an answer the parser loses, and cannot name a stage that does
 *   not exist.
 */
export const DECISION_CALL = {
  tier: "decision",
  temperature: 0,
  thinking: "disabled",
  structuredOutput: true,
} as const;

/** Models that refuse a `temperature` parameter (400). */
export function refusesTemperature(model: string): boolean {
  return /^claude-(sonnet|opus|fable|mythos)-[5-9]/.test(model) || /^claude-opus-4-[78]/.test(model);
}

/**
 * Models known to accept `thinking: {type: "disabled"}`: Sonnet 5, Opus 5 (at
 * its default effort) and Opus 4.7/4.8 (Anthropic's model table, checked
 * 2026-09-30). Opus 5.5 and the Fable and Mythos models answer it with a 400,
 * so for any model not listed here the parameter is left out and the model
 * thinks as it defaults to: a decision that costs more beats one that is
 * never made.
 */
export function acceptsThinkingDisabled(model: string): boolean {
  return /^claude-sonnet-5(-\d{8})?$/.test(model) || /^claude-opus-5(-\d{8})?$/.test(model) || /^claude-opus-4-[78](-\d{8})?$/.test(model);
}

const DEFAULTS = {
  /**
   * The tiers now resolve to different models, measured rather than assumed.
   *
   * Both were run through the real pipeline on 2026-08-30, same keywords, same
   * research, full target length. Haiku matched the derived word count more
   * closely (1.01x vs 0.81x) and was clean on the fact checker for two of three
   * keywords, so it is not a bad writer. But on the same article Sonnet named
   * real products where Haiku wrote "the right platform should automate
   * repetitive tasks", produced 2 links against 0, dated its own title 2025,
   * and Haiku wrapped the whole response in a ```html fence that would have
   * shipped as literal text (see stripCodeFence in lib/ai/utils.ts).
   *
   * So: `structured` drops to Haiku, where the work is short, shaped and
   * checkable - meta descriptions, clusters, SERP summaries, relevance scores.
   * `content` stays on Sonnet, because the article is the product and the
   * difference showed up in exactly the things that make one worth reading.
   *
   * Both remain env-overridable. Point ANTHROPIC_MODEL at Haiku to run the
   * whole thing cheap and judge for yourself.
   */
  anthropicContent: "claude-sonnet-5",
  anthropicStructured: "claude-haiku-4-5-20251001",
  anthropicDecision: "claude-sonnet-5",

  /**
   * Left as-is. This was already the OpenAI default and is a current model;
   * guessing at a newer id would risk a 404 on every OpenAI-backed workspace.
   */
  openaiContent: "gpt-4o",
  // `dall-e-3` was the default and is not in the account's model list at all
  // (checked 2026-09-04), so every image call returned model-not-found. The
  // mini tier is the cheapest that produces a usable hero, and this runs on
  // every generated article.
  openaiImage: "gpt-image-1-mini",
} as const;

function fromEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/** Anthropic model for a given tier. */
export function anthropicModel(tier: ModelTier = "content"): string {
  // A self-hoster who pins one model with ANTHROPIC_MODEL (a key or proxy
  // without Sonnet 5) gets it for the decisions too, as for `structured`.
  if (tier === "decision") return fromEnv("ANTHROPIC_MODEL_DECISION", fromEnv("ANTHROPIC_MODEL", DEFAULTS.anthropicDecision));
  return tier === "structured"
    ? fromEnv("ANTHROPIC_MODEL_STRUCTURED", fromEnv("ANTHROPIC_MODEL", DEFAULTS.anthropicStructured))
    : fromEnv("ANTHROPIC_MODEL", DEFAULTS.anthropicContent);
}

/**
 * The text of a reply: its first text block, or null when it has none.
 *
 * Not `content[0]`: a model that thinks first (claude-sonnet-5, seen
 * 2026-09-29) puts a thinking block there, and eight readers that took the
 * first block as the answer read "no answer" - replaying the results judge on
 * it, 29 of 37 verdicts came back unusable. Structural, so this module needs
 * no SDK import.
 */
export function replyText(content: ReadonlyArray<{ type: string }>): string | null {
  const block = content.find((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string");
  return block ? block.text : null;
}

/** OpenAI chat model, used when a workspace picks OpenAI as its provider. */
export function openaiModel(): string {
  return fromEnv("OPENAI_MODEL", DEFAULTS.openaiContent);
}

/** OpenAI image model for featured images. */
export function openaiImageModel(): string {
  return fromEnv("OPENAI_IMAGE_MODEL", DEFAULTS.openaiImage);
}

/** The defaults, for docs and for tests that assert on them. */
export const MODEL_DEFAULTS = DEFAULTS;

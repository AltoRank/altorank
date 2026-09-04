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
  | "structured";

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
  return tier === "structured"
    ? fromEnv("ANTHROPIC_MODEL_STRUCTURED", fromEnv("ANTHROPIC_MODEL", DEFAULTS.anthropicStructured))
    : fromEnv("ANTHROPIC_MODEL", DEFAULTS.anthropicContent);
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

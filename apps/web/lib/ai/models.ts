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
   * Both Anthropic tiers currently resolve to the same model.
   *
   * That is deliberate. `structured` exists so the cheap, high-volume calls can
   * be pointed at a smaller model without touching code, but defaulting it
   * there would quietly change the output of briefs, clusters and meta
   * descriptions as a side effect of a refactor that was only meant to remove
   * duplication. Set ANTHROPIC_MODEL_STRUCTURED to opt in.
   */
  anthropicContent: "claude-sonnet-5",
  anthropicStructured: "claude-sonnet-5",

  /**
   * Left as-is. This was already the OpenAI default and is a current model;
   * guessing at a newer id would risk a 404 on every OpenAI-backed workspace.
   */
  openaiContent: "gpt-4o",
  openaiImage: "dall-e-3",
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

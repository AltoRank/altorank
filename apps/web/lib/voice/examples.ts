import type { SupabaseClient } from "@supabase/supabase-js";
import { pageText } from "@/lib/onboarding/site-text";
import { e2eStubsEnabled } from "@/lib/e2e/stubs";

// ---------------------------------------------------------------------------
// "Your best writing": the articles a person chose to learn the voice from
// ---------------------------------------------------------------------------
//
// The onboarding wizard and Settings > Blog both ask for up to three articles
// and say drafts learn their voice from them before anything else. They were
// saved to `workspaces.example_article_urls` and never read: the voice was
// trained from the homepage and product pages (lib/onboarding/site-text.ts).
// These are now read and put first in the sample the voice is trained on,
// by onboarding and again whenever the list is changed in Settings.

/** At most this many, as the form allows. */
export const MAX_EXAMPLES = 3;

/** How much of each chosen article goes into the sample. */
const PER_ARTICLE_CHARS = 4_000;

/** The sample the voice analyser reads at most. */
export const VOICE_SAMPLE_CHARS = 12_000;

/** Fewer words than this is not a sample worth training on (the pipeline's own floor). */
export const MIN_VOICE_WORDS = 50;

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** The URLs saved on the workspace, read fresh: the wizard may have saved them after a run started. */
export async function readExampleUrls(supabase: SupabaseClient, workspaceId: string): Promise<string[]> {
  try {
    const { data } = await supabase.from("workspaces").select("example_article_urls").eq("id", workspaceId).maybeSingle();
    const urls = (data as { example_article_urls?: unknown } | null)?.example_article_urls;
    return Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)) : [];
  } catch {
    return [];
  }
}

/** The text of the chosen articles, each under a SOURCE line, or "" when none answered. */
export async function readExampleArticles(
  urls: string[],
  read: (url: string) => Promise<{ text: string }> = pageText,
): Promise<string> {
  const chosen = urls.slice(0, MAX_EXAMPLES);
  if (!chosen.length || e2eStubsEnabled()) return "";
  const pages = await Promise.all(chosen.map((u) => read(u).catch(() => ({ text: "" }))));
  return pages
    .map((p, i) => (p.text.trim() ? `SOURCE ${chosen[i]}\n${p.text.trim().slice(0, PER_ARTICLE_CHARS)}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** The chosen articles first, then whatever else was read, cut to what the analyser takes. */
export function composeVoiceSample(examples: string, rest: string, maxChars = VOICE_SAMPLE_CHARS): string {
  return [examples.trim(), rest.trim()].filter(Boolean).join("\n\n").slice(0, maxChars);
}

/** The sample without the blocks of articles chosen before, so a changed list replaces them rather than piling up. */
export function withoutChosenArticles(sample: string, urls: string[]): string {
  if (!urls.length) return sample;
  const heads = new Set(urls.map((u) => `SOURCE ${u}`));
  return sample
    .split("\n\n")
    .filter((block) => !heads.has(block.split("\n", 1)[0]))
    .join("\n\n");
}

/**
 * Retrain a trained voice when the chosen articles change. The chosen
 * articles go first and the rest of the current sample (the site text
 * onboarding read) follows, so nothing is re-crawled. A site whose voice has
 * not been trained yet is left alone: onboarding reads the list itself.
 * Returns whether the voice was retrained.
 */
export async function retrainFromExamples(
  supabase: SupabaseClient,
  workspaceId: string,
  urls: string[],
  previous: string[],
  deps: {
    read?: (url: string) => Promise<{ text: string }>;
    train: (supabase: SupabaseClient, workspaceId: string, sample: string) => Promise<void>;
  },
): Promise<boolean> {
  const { data: profile } = await supabase
    .from("voice_profiles")
    .select("sample_text, trained")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!profile?.trained) return false;

  const chosen = await readExampleArticles(urls, deps.read);
  if (wordCount(chosen) < MIN_VOICE_WORDS) return false;

  const rest = withoutChosenArticles((profile.sample_text as string | null) ?? "", previous);
  await deps.train(supabase, workspaceId, composeVoiceSample(chosen, rest));
  return true;
}

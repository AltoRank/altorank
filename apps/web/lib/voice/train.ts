// ---------------------------------------------------------------------------
// Learning how a site writes
// ---------------------------------------------------------------------------
//
// The analysis and the write, with the client handed in. The server action in
// app/actions/voice.ts wraps this with the session check and the revalidate;
// the onboarding worker calls it with the service client, because it has no
// session. Until 2026-09-07 the pipeline called the action itself, which was
// fine inside the SSE request (the cookies were there) and failed the moment
// the run moved to its own invocation: "Could not read your site — Not
// authenticated", on every run, from the one phase that needs no
// authorisation beyond the workspace id.

import type { SupabaseClient } from "@supabase/supabase-js";
import { analyzeVoiceWithAI } from "@/lib/ai/voice-analyzer";
import { resolveLocale, notCheckedFor, scaleWords } from "@/lib/i18n/locale";

/**
 * `workspaces.language`, for a caller that only has the id. A missing row or
 * column is the column's own default.
 */
async function workspaceLanguage(supabase: SupabaseClient, workspaceId: string): Promise<string> {
  try {
    const { data } = await supabase.from("workspaces").select("language").eq("id", workspaceId).maybeSingle();
    const language = (data as { language?: unknown } | null)?.language;
    return typeof language === "string" && language.trim() ? language : "en";
  } catch {
    return "en";
  }
}

/**
 * Analyse a sample and upsert the workspace's voice profile from it. The
 * sample is read in the site's language, looked up when not given.
 */
export async function trainVoiceProfile(
  supabase: SupabaseClient,
  workspaceId: string,
  sampleText: string,
  language?: string | null,
): Promise<void> {
  const rules = await analyzeVoice(sampleText, language ?? (await workspaceLanguage(supabase, workspaceId)));

  const { error } = await supabase
    .from("voice_profiles")
    .upsert(
      {
        workspace_id: workspaceId,
        sample_text: sampleText,
        rules,
        trained: true,
        created_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" },
    );

  if (error) throw new Error(error.message);
}

/**
 * Analyze voice — tries AI-powered analysis first, falls back to local heuristics.
 */
export async function analyzeVoice(sample: string, language?: string | null): Promise<Record<string, unknown>> {
  try {
    return (await analyzeVoiceWithAI([sample], language)) as Record<string, unknown>;
  } catch {
    // Fallback to local analysis when API key is missing or AI fails
    return analyzeVoiceLocally(sample, language);
  }
}

/**
 * Local voice analysis — extracts tone, vocabulary patterns, and style rules from sample text.
 * Runs without AI as a fallback.
 *
 * Pronouns, address and imperatives are language, and the markers come from
 * the locale contract (lib/i18n/locale). The English regexes this used to run
 * on every sample never saw that a Turkish agency (a real signup, 2026-09-22)
 * writes as "we" - in Turkish that is mostly a suffix ("ekibimiz", our team;
 * "sunuyoruz", we offer), not the word "biz". In a language the contract does
 * not describe, only what needs no language is reported (em dashes), and
 * `unchecked` says what was not read rather than tagging the sample
 * "formal (no contractions)" by an English rule.
 */
export function analyzeVoiceLocally(sample: string, language?: string | null): Record<string, unknown> {
  const locale = resolveLocale(language);
  const sentences = sample.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = locale.lower(sample).split(/\s+/);
  const avgSentenceLength = Math.round(words.length / Math.max(sentences.length, 1));

  const tags: string[] = [];
  const dashes = sample.includes("—") ? "uses em-dashes" : "no em-dashes";

  if (!locale.supported) {
    return {
      tags: [dashes],
      wordCount: words.length,
      sentenceCount: sentences.length,
      unchecked: `Sentence length, pronouns, address and contractions: ${notCheckedFor(locale)}`,
    };
  }

  const { voice } = locale;
  // Only where contractions mark register (English); an Italian elision is
  // grammar, and "formal (no contractions)" on a Turkish sample was an
  // English rule reporting the absence of English.
  if (voice.contractions) {
    tags.push(voice.contractions.test(sample) ? "contractions OK" : "formal (no contractions)");
  }

  // Sentence length in this language's words: 15 and 25 English words are
  // 12 and 20 Turkish ones.
  if (avgSentenceLength <= scaleWords(15, locale)) {
    tags.push("short sentences");
  } else if (avgSentenceLength > scaleWords(25, locale)) {
    tags.push("long-form");
  }

  tags.push(dashes);

  if (voice.firstPersonPlural.test(sample)) {
    tags.push("first-person plural");
  }
  if (voice.firstPersonSingular.test(sample)) {
    tags.push("first-person singular");
  }

  if (voice.directAddress.test(sample)) {
    tags.push("direct address");
  }

  if (voice.direct.test(sample)) {
    tags.push("direct");
  }
  if (avgSentenceLength <= scaleWords(12, locale)) {
    tags.push("punchy");
  }

  return {
    tags,
    avgSentenceLength,
    wordCount: words.length,
    sentenceCount: sentences.length,
    language: locale.code,
  };
}

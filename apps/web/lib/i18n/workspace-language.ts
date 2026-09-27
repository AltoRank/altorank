// ---------------------------------------------------------------------------
// The site's language, for a caller that only has the workspace id
// ---------------------------------------------------------------------------
//
// `workspaces.language` is NOT NULL (migration 004), so a caller that reads
// the row always gets a language. A caller that could NOT read it used to
// default to English, each in its own way: a `catch { return "en" }` in the
// voice trainer, a `?? null` in the approval gate that `resolveLocale` then
// turned into English. A Turkish site whose row failed to load was scored,
// fact-checked and voice-profiled with English rules, and nobody was told.
//
// So a failed read is `UNKNOWN_LANGUAGE` ("und"), which the locale contract
// resolves to an unsupported language: every check says "Not checked: the
// site's language could not be read" instead of guessing, and the failure is
// written to `system_events` where an operator will see it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { UNKNOWN_LANGUAGE } from "@/lib/i18n/locale";

/**
 * `workspaces.language` for `workspaceId`, or `UNKNOWN_LANGUAGE` when it
 * cannot be read. Never throws. `source` names the caller in the event log
 * ("seo.score", "voice.train").
 */
export async function readWorkspaceLanguage(
  supabase: SupabaseClient,
  workspaceId: string,
  source: string,
): Promise<string> {
  let reason: string;
  try {
    const { data, error } = await supabase.from("workspaces").select("language").eq("id", workspaceId).maybeSingle();
    const language = (data as { language?: unknown } | null)?.language;
    if (typeof language === "string" && language.trim()) return language;
    reason = error?.message ?? "no workspace row";
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  // Lazy: the recorder holds the service client, and nothing that only reads
  // a language should pull that into its import graph.
  try {
    const { recordEvent } = await import("@/lib/observability/record");
    await recordEvent({
      level: "warn",
      source: `locale.${source}`,
      message: `Could not read the site's language (${reason}); its text was not checked rather than read as English.`,
      workspaceId,
    });
  } catch {
    console.error(`[locale] ${source}: could not read the language of workspace ${workspaceId}: ${reason}`);
  }
  return UNKNOWN_LANGUAGE;
}

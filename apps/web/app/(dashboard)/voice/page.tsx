import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getVoiceProfiles } from "@/lib/queries/voice";
import { PageHead, StatusPill, Avatar, Chip } from "@/components/ui";
import { VoiceActions } from "@/components/dashboard/voice-actions";
import { VoiceCardButton } from "@/components/dashboard/voice-card-button";
import type { VoiceProfile } from "@/lib/types";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Brand voice" };

export default async function VoicePage() {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const [allWorkspaces, voiceProfiles] = await Promise.all([
    getWorkspaces(),
    getVoiceProfiles(scopeId ?? undefined),
  ]);
  // A voice belongs to one site. Showing every site's card here made the
  // page look like it had trained a voice it had not (2026-09-02).
  const workspaces = scopeId ? allWorkspaces.filter((w) => w.id === scopeId) : allWorkspaces;

  const voiceMap = new Map<string, VoiceProfile>(voiceProfiles.map((v) => [v.workspace_id, v]));

  return (
    <>
      {/* "Brand voice", which is what the sidebar item a person clicked to
          get here says, and what the browser tab says. It was "Voice
          library" in the heading, "Brand Voice" in the tab and "Brand voice"
          in the nav: three names for one page.

          The header's Trained pill is gone. The scope gives this page one
          site, so the pill was an aggregate over one card and sat six
          centimetres from that card's own identical pill; the card is where
          the state belongs, because it is per voice. The domain stays out of
          the subtitle for the same reason - the switcher, the card title and
          the card subtitle already carried it, four times on one screen. */}
      <PageHead
        title="Brand voice"
        subtitle="Trained on sample text you approve. Articles for a workspace are written in its voice."
        actions={<VoiceActions workspaces={workspaces} />}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {workspaces.map((w) => {
            const voice = voiceMap.get(w.id);
            const rules = voice?.rules as {
              tags?: string[];
              wordCount?: number;
              sentenceCount?: number;
              avgSentenceLength?: number;
              toneArchetype?: string;
              formalityLevel?: string;
              sentenceRhythm?: string;
              emotionalRegister?: string;
              technicalDepth?: string;
              audienceAwareness?: string;
              signaturePhrases?: string[];
              writingPatterns?: string[];
            } | undefined;
            const tags = rules?.tags ?? [];
            const sentences = voice?.sample_text
              ? voice.sample_text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0)
              : [];

            // Derived from the stored sample, not from `rules`. These were read
            // as rules.wordCount / rules.sentenceCount / rules.avgSentenceLength,
            // none of which exist on VoiceRules and none of which the analyzer
            // returns, so every trained profile displayed "0 words | 0 sentences
            // | avg 0 words/sentence" regardless of the sample it was built from.
            const wordCount = voice?.sample_text
              ? voice.sample_text.split(/\s+/).filter(Boolean).length
              : 0;
            const avgSentenceLength = sentences.length
              ? Math.round(wordCount / sentences.length)
              : 0;
            return (
              <div key={w.id} className="border border-line rounded-xl p-[18px] bg-bg">
                <div className="flex items-center gap-2.5 mb-3.5">
                  <Avatar initials={w.initials} color={w.color} size="lg" />
                  <div className="flex-1 min-w-0">
                    {/* A workspace's name defaults to its domain, so this
                        printed the same string twice in two typefaces on
                        every card an account has not renamed. */}
                    <div className="font-semibold text-sm truncate">{w.name}</div>
                    {w.domain && w.domain !== w.name && (
                      <div className="font-mono text-[11px] text-ink-3 truncate">{w.domain}</div>
                    )}
                  </div>
                  <StatusPill status={voice?.trained ? "on" : "setup"} label={voice?.trained ? "Trained" : "Not trained"} />
                </div>
                {voice?.trained && rules ? (
                  <div className="bg-panel border border-line rounded-[7px] px-3 py-2.5 mb-3">
                    {/* AI-powered profile fields */}
                    {rules.toneArchetype && (
                      <div className="flex items-center gap-2 text-[11.5px] mb-2">
                        <span className="text-ink-3">Archetype:</span>
                        <span className="text-ink font-medium capitalize">{rules.toneArchetype}</span>
                        {rules.formalityLevel && (
                          <>
                            <span className="text-line">|</span>
                            <span className="text-ink-3">Formality:</span>
                            <span className="text-ink font-medium capitalize">{rules.formalityLevel}</span>
                          </>
                        )}
                        {rules.technicalDepth && (
                          <>
                            <span className="text-line">|</span>
                            <span className="text-ink-3">Depth:</span>
                            <span className="text-ink font-medium capitalize">{rules.technicalDepth}</span>
                          </>
                        )}
                      </div>
                    )}

                    {/* Stats row */}
                    <div className="flex items-center gap-3 text-[11px] text-ink-3 font-mono mb-2">
                      <span>{plural(wordCount, "word")}</span>
                      <span className="text-line">|</span>
                      <span>{plural(sentences.length, "sentence")}</span>
                      <span className="text-line">|</span>
                      <span>avg {avgSentenceLength} words/sentence</span>
                    </div>

                    {rules.emotionalRegister && (
                      <div className="text-[11.5px] text-ink-2 mb-2">
                        <span className="text-ink-3">Register: </span>{rules.emotionalRegister}
                      </div>
                    )}

                    {rules.audienceAwareness && (
                      <div className="text-[11.5px] text-ink-2 mb-2">
                        <span className="text-ink-3">Audience: </span>{rules.audienceAwareness}
                      </div>
                    )}

                    {/* Extracted sentences preview */}
                    {sentences.length > 0 && (
                      <div className="space-y-1.5">
                        {sentences.slice(0, 3).map((s, i) => (
                          <div key={i} className="text-[12px] text-ink-2 leading-[1.5] pl-2 border-l-2 border-accent/30">
                            {s}.
                          </div>
                        ))}
                        {sentences.length > 3 && (
                          <div className="text-[11px] text-ink-3">
                            +{plural(sentences.length - 3, "more sentence", "more sentences")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : voice?.sample_text ? (
                  <div className="bg-panel border border-line rounded-[7px] px-3 py-2.5 text-[12.5px] text-ink-2 leading-[1.5] mb-3">
                    {voice.sample_text}
                  </div>
                ) : (
                  <div className="bg-panel border border-line rounded-[7px] px-3 py-2.5 text-[12.5px] text-ink-3 leading-[1.5] mb-3 italic">
                    No sample text yet
                  </div>
                )}
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-[5px] mb-3">
                    {tags.map((t) => (
                      <Chip key={t} label={t} soft className="text-[11px]" />
                    ))}
                  </div>
                )}
                <VoiceCardButton
                  workspaceId={w.id}
                  trained={!!voice?.trained}
                  hasSample={!!voice?.sample_text}
                  /* Retrain re-reads the site; this edits what it concluded.
                     Two different repairs: the site changed, or the model read
                     it wrong. Only the first is fixed by asking again. */
                  profileId={voice?.id ?? null}
                  rules={(voice?.rules as Record<string, unknown>) ?? null}
                />
              </div>
            );
          })}
          {workspaces.length === 0 && (
            <div className="col-span-3 text-center text-ink-3 py-8">No workspaces found</div>
          )}
        </div>
      </div>
    </>
  );
}

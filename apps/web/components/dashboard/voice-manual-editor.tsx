"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { updateVoiceProfile } from "@/app/actions/voice";

/**
 * Edit the voice by hand.
 *
 * "Edit voice" already existed and did not edit anything: it called
 * retrainVoice, which re-scrapes the site and asks the model again. That is
 * the right button when the site has changed and the wrong one when the model
 * simply read the site wrong - and it read altorank.co as "provocative", which
 * is a judgement no amount of re-scraping will revise.
 *
 * `updateVoiceProfile` has been in app/actions/voice.ts the whole time with no
 * caller. This is the caller.
 *
 * ## Only fields the writer actually reads
 *
 * Every field here appears in lib/ai/prompts.ts and changes the article that
 * comes out. The stored profile carries a few more keys - `tone` is a legacy
 * fallback used only when toneArchetype is empty, `sentenceRhythm` is derived
 * statistics - and offering those for editing would be theatre: you would
 * change them and nothing would happen.
 */

type Rules = Record<string, unknown>;

const TEXT_FIELDS = [
  {
    key: "toneArchetype",
    label: "Tone archetype",
    hint: "One or two words. The single strongest lever on how a draft reads.",
  },
  { key: "formalityLevel", label: "Formality", hint: "e.g. conversational, formal, technical" },
  { key: "technicalDepth", label: "Technical depth", hint: "e.g. beginner, intermediate, expert" },
  { key: "emotionalRegister", label: "Register", hint: "The feel: dry, warm, urgent, plain" },
  { key: "audienceAwareness", label: "Audience", hint: "Who the draft is written for" },
] as const;

const LIST_FIELDS = [
  { key: "vocabulary", label: "Preferred vocabulary", hint: "Words to reach for" },
  { key: "signaturePhrases", label: "Signature phrases", hint: "Turns of phrase that sound like you" },
  { key: "writingPatterns", label: "Writing patterns", hint: "Structural habits to follow" },
  { key: "avoidPatterns", label: "Avoid", hint: "Words and patterns to keep out" },
  { key: "tags", label: "Themes", hint: "What the content is about" },
] as const;

const asText = (v: unknown) => (typeof v === "string" ? v : "");
const asList = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "");

export function VoiceManualEditor({
  profileId,
  rules,
  onDone,
}: {
  profileId: string;
  rules: Rules;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const f of TEXT_FIELDS) d[f.key] = asText(rules[f.key]);
    for (const f of LIST_FIELDS) d[f.key] = asList(rules[f.key]);
    return d;
  });

  function save() {
    start(async () => {
      try {
        // Merge rather than replace: the profile holds keys this form does not
        // show (sentenceRhythm, the legacy `tone`), and writing the form back
        // wholesale would silently drop them.
        const next: Rules = { ...rules };
        for (const f of TEXT_FIELDS) {
          const v = draft[f.key].trim();
          if (v) next[f.key] = v;
          else delete next[f.key];
        }
        for (const f of LIST_FIELDS) {
          const items = draft[f.key].split(",").map((s) => s.trim()).filter(Boolean);
          if (items.length) next[f.key] = items;
          else delete next[f.key];
        }
        // Recorded so the UI can warn before a retrain throws these away.
        next.editedManuallyAt = new Date().toISOString();

        await updateVoiceProfile(profileId, { rules: next });
        toast.success("Voice updated. New drafts will use it.");
        onDone?.();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save the voice");
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 max-w-[72ch] text-[12.5px] leading-relaxed text-ink-2">
        These are the fields the writer actually reads. Changing one changes the
        next draft.{" "}
        <b className="font-medium text-ink">Retraining overwrites all of them</b>,
        because it asks the model to read the site again from scratch.
      </p>

      <div className="grid gap-3.5 md:grid-cols-2">
        {TEXT_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              {f.label}
            </span>
            <input
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              className="rounded-[7px] border border-line bg-bg px-2.5 py-2 text-[13px] focus:border-accent focus:outline-0"
            />
            <span className="text-[11px] text-ink-3">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-3.5">
        {LIST_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
              {f.label} <span className="normal-case tracking-normal">— comma separated</span>
            </span>
            <textarea
              rows={2}
              value={draft[f.key]}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              className="resize-y rounded-[7px] border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed focus:border-accent focus:outline-0"
            />
            <span className="text-[11px] text-ink-3">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="flex gap-2">
        <Button variant="accent" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save voice"}
        </Button>
        {onDone && (
          <Button onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

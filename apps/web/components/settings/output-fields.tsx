"use client";

import { TONES, TONE_LABELS, type OutputSettings } from "@/lib/onboarding/output-settings";
import { Field, Toggle, inputClass } from "./fields";

/**
 * The one setting nobody can change, shown as a setting so the question
 * "where do I turn on auto-publish" is answered where it would be asked.
 */
export function ApprovalGateCard() {
  return (
    <div className="flex items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
      <div>
        <div className="text-[13px] font-medium">Every draft waits for your yes</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
          Articles land in review and publish only when you approve them. This is not a setting you can turn
          off, and it is the difference between a tool and a firehose.
        </div>
      </div>
      <span className="mt-0.5 shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] text-ink-2">
        ALWAYS ON
      </span>
    </div>
  );
}

/** Tone, links, the four switches and the standing instruction. */
export function OutputFields({ output, setOutput }: { output: OutputSettings; setOutput: (o: OutputSettings) => void }) {
  const set = (p: Partial<OutputSettings>) => setOutput({ ...output, ...p });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Tone" hint="The default voice. Brand voice learned from your writing refines it.">
          <select className={inputClass} value={output.tone} onChange={(e) => set({ tone: e.target.value as OutputSettings["tone"] })}>
            {TONES.map((t) => (
              <option key={t} value={t}>
                {TONE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Internal links per article">
          <select className={inputClass} value={String(output.internalLinks)} onChange={(e) => set({ internalLinks: Number(e.target.value) })}>
            {[0, 2, 3, 5, 8].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "None" : `${n} links`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Toggle
        label="Table of contents"
        hint="Added from the heading structure of each article."
        checked={output.tableOfContents}
        onChange={(v) => set({ tableOfContents: v })}
      />
      <Toggle
        label="Call to action"
        hint="A closing section that points readers at your site."
        checked={output.callToAction}
        onChange={(v) => set({ callToAction: v })}
      />
      <Toggle
        label="First-person writing"
        hint='Allows "we" and "our" when it reads naturally. Off means third person only.'
        checked={output.firstPerson}
        onChange={(v) => set({ firstPerson: v })}
      />
      <Toggle
        label="Mention similar products"
        hint="Compare and reference alternatives where relevant. Off keeps articles to your own category."
        checked={output.mentionSimilarProducts}
        onChange={(v) => set({ mentionSimilarProducts: v })}
      />
      <Field
        label="Anything drafts should always do"
        hint="Optional. Brand voice is learned from your published writing; this is for rules that writing cannot show. Most sites leave it empty."
      >
        <textarea
          rows={3}
          className={`${inputClass} resize-none`}
          placeholder="e.g. never claim we are the cheapest; always mention the free tier"
          value={output.globalArticlePrompt}
          onChange={(e) => set({ globalArticlePrompt: e.target.value })}
        />
      </Field>
    </div>
  );
}

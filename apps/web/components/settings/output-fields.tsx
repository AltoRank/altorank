"use client";

import {
  TONES,
  TONE_LABELS,
  IMAGE_STYLES,
  IMAGE_STYLE_LABELS,
  FEATURED_IMAGE_STYLES,
  FEATURED_IMAGE_STYLE_LABELS,
  parseBrandColor,
  parseYouTubeChannel,
  type OutputSettings,
} from "@/lib/onboarding/output-settings";
import { Field, Toggle, RadioTiles, inputClass } from "./fields";

/**
 * Who decides that a draft ships (migration 079). Two tiles: review each draft,
 * or publish automatically after a day unless held. Rendered by the wizard's
 * Articles step, where it is saved with that step, and by Settings > Articles
 * as a pointer to the workspace card that owns the thresholds.
 *
 * Either way the same hard checks run before anything ships - unsourced
 * figures, failing audit items, no plan - and a held draft says why on its row.
 * The copy says that once, because "automatic" without it reads as a firehose.
 */
export function ApprovalGateCard({
  value,
  onChange,
}: {
  /** Undefined renders the read-only pointer used on Settings > Articles. */
  value?: boolean;
  onChange?: (auto: boolean) => void;
}) {
  if (value === undefined || !onChange) {
    return (
      <div className="flex items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
        <div>
          <div className="text-[13px] font-medium">Who decides a draft ships</div>
          <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">
            Review each draft, or publish automatically after a hold unless you hold it. Set per workspace under
            Workspaces &rarr; Settings &rarr; Publishing decision; the same checks (sources, audit, plan) run either way.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Publishing decision</SectionLabel>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          { auto: true, title: "Publish automatically", hint: "Each draft is emailed to you when written and ships a day later unless you hold it. Same checks as a click: sources, audit, plan." },
          { auto: false, title: "Review each draft", hint: "Nothing publishes until someone clicks Approve. Pick this for client sites and regulated niches." },
        ].map((o) => (
          <button
            key={String(o.auto)}
            type="button"
            onClick={() => onChange(o.auto)}
            aria-pressed={value === o.auto}
            className={`rounded-[8px] border px-4 py-3 text-left transition-colors ${value === o.auto ? "border-accent bg-accent-soft/20" : "border-line bg-bg hover:border-ink-3"}`}
          >
            <div className="text-[13px] font-medium">{o.title}</div>
            <div className="mt-0.5 text-[12px] leading-[1.5] text-ink-3">{o.hint}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-3">{children}</div>;
}

/**
 * Tone, links, the writing switches, the structure switches, the image
 * presets and the standing instruction. One component, rendered by the
 * wizard's Articles step and the Settings > Articles tab.
 *
 * Every hint says what the draft actually does differently, because each
 * switch is either a prompt line (lib/ai/prompts.ts) or an enrichment step
 * (lib/content/enrich) and nothing else.
 */
export function OutputFields({ output, setOutput }: { output: OutputSettings; setOutput: (o: OutputSettings) => void }) {
  const set = (p: Partial<OutputSettings>) => setOutput({ ...output, ...p });
  const colorTyped = output.brandColor ?? "";
  const colorInvalid = colorTyped.trim() !== "" && !parseBrandColor(colorTyped);
  const channelTyped = output.youtubeChannel ?? "";
  const channelInvalid = channelTyped.trim() !== "" && !parseYouTubeChannel(channelTyped);

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Writing</SectionLabel>
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
      <Toggle
        label="Emojis"
        hint="On lets the writer use one emoji per heading or list item. Off tells it to use none at all."
        checked={output.emojis}
        onChange={(v) => set({ emojis: v })}
      />

      <SectionLabel>Structure</SectionLabel>
      <Toggle
        label="Table of contents"
        hint="Added from the heading structure of each article."
        checked={output.tableOfContents}
        onChange={(v) => set({ tableOfContents: v })}
      />
      <Toggle
        label="Call to action"
        hint="A closing section that names your business and links to your site. No offer is invented."
        checked={output.callToAction}
        onChange={(v) => set({ callToAction: v })}
      />
      <Toggle
        label="Infographics"
        hint="When the text states three or more comparable numbers, or a before-and-after pair, a bar chart of exactly those numbers is added beside them. Nothing is charted that the text does not say."
        checked={output.infographics}
        onChange={(v) => set({ infographics: v })}
      />
      <Toggle
        label="FAQ schema"
        /* Was "It is not sent to your site yet", written 2026-09-06 when that
           was true. lib/publishing/schema.ts landed after it and made the
           delivery real: publishArticleCore rebuilds the schema from the final
           HTML and appends it for SCRIPT_CAPABLE destinations
           (lib/publishing/core.ts:232-261). The caveat that survives is which
           destinations, not whether - so the hint names both lists rather than
           denying the feature. Update it with SCRIPT_CAPABLE. */
        hint="If the article has a FAQ section, its questions and answers ship with it as FAQPage structured data, rebuilt from the final text at publish time. WordPress, Ghost, Shopify, WooCommerce, HubSpot and git get it as a JSON-LD tag; a webhook gets it as a field. Notion, Wix, Webflow and Framer rebuild the body into their own blocks, so they get none. The visible text is unchanged either way."
        checked={output.faqSchema}
        onChange={(v) => set({ faqSchema: v })}
      />
      <Toggle
        label="YouTube video"
        hint="One embedded video in the first how-to section, found by that section's heading. Articles without a how-to section get none."
        checked={output.video}
        onChange={(v) => set({ video: v })}
      />
      {output.video && (
        <Field
          label="Only from this channel"
          hint={
            channelInvalid
              ? "Not a channel: paste a channel id (UC…), a handle (@name) or the channel's URL."
              : "Optional. With a channel set, only its videos are embedded; an article whose topic it has not covered gets no video rather than someone else's."
          }
        >
          <input
            className={`${inputClass} ${channelInvalid ? "border-err" : ""}`}
            placeholder="@yourchannel or https://www.youtube.com/@yourchannel"
            value={channelTyped}
            aria-invalid={channelInvalid || undefined}
            onChange={(e) => set({ youtubeChannel: e.target.value || null })}
            onBlur={() => {
              const parsed = parseYouTubeChannel(channelTyped);
              if (parsed) set({ youtubeChannel: parsed });
            }}
          />
        </Field>
      )}

      <SectionLabel>Images</SectionLabel>
      <Field label="Body images" hint="Two or three generated images between sections, in this style. Descriptions, not samples: each preset is a line in the image prompt.">
        <RadioTiles
          name="image-style"
          value={output.imageStyle}
          options={IMAGE_STYLES.map((v) => ({ value: v, ...IMAGE_STYLE_LABELS[v] }))}
          onChange={(v) => set({ imageStyle: v })}
        />
      </Field>
      <Field label="Featured image" hint="The cover above the article, also used as the social preview.">
        <RadioTiles
          name="featured-image-style"
          value={output.featuredImageStyle}
          options={FEATURED_IMAGE_STYLES.map((v) => ({ value: v, ...FEATURED_IMAGE_STYLE_LABELS[v] }))}
          onChange={(v) => set({ featuredImageStyle: v })}
        />
      </Field>
      <Field
        label="Brand colour"
        hint={
          colorInvalid
            ? "Six hex digits, like #1a1815."
            : "Optional. Used as the bar colour in infographics and named as the accent in every image prompt, including the title cover's background. Not applied to the article text."
        }
      >
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick brand colour"
            className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-line bg-panel p-1"
            value={parseBrandColor(colorTyped) ?? "#000000"}
            onChange={(e) => set({ brandColor: e.target.value })}
          />
          <input
            className={`${inputClass} font-mono ${colorInvalid ? "border-err" : ""}`}
            placeholder="#1a1815"
            value={colorTyped}
            aria-invalid={colorInvalid || undefined}
            onChange={(e) => set({ brandColor: e.target.value || null })}
            onBlur={() => {
              const parsed = parseBrandColor(colorTyped);
              if (parsed) set({ brandColor: parsed });
            }}
          />
          {colorTyped && (
            <button type="button" className="text-[12px] text-ink-3 hover:text-ink" onClick={() => set({ brandColor: null })}>
              Clear
            </button>
          )}
        </div>
      </Field>

      <SectionLabel>Standing instructions</SectionLabel>
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

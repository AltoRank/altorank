"use client";

import { Icons } from "@/components/ui";
import { IntegrationIcon } from "@/components/dashboard/integration-icon";
import { ATTRIBUTION_SOURCES, ATTRIBUTION_NOTE_MAX, type AttributionSource } from "@/lib/attribution";

/** What the screen holds before it is an answer: nothing picked, or Other with an empty box. */
export type AttributionDraft = { source: AttributionSource | null; note: string };

export const EMPTY_ATTRIBUTION: AttributionDraft = { source: null, note: "" };

/** True once the draft would pass parseAttribution. The Continue button reads this. */
export function attributionComplete(d: AttributionDraft): boolean {
  return d.source !== null && (d.source !== "other" || d.note.trim().length > 0);
}

/**
 * Ten tiles, one pick, one click.
 *
 * Tiles rather than a select because the list is short and the marks do the
 * reading: a person who came from a chat window finds the assistant's mark
 * before they find the word "AI" in a dropdown. The wizard shows two columns
 * at 720px; Settings has room for five.
 */
export function AttributionPicker({
  value,
  onChange,
  columns = 2,
}: {
  value: AttributionDraft;
  onChange: (next: AttributionDraft) => void;
  columns?: 2 | 5;
}) {
  return (
    <div>
      <div role="radiogroup" aria-label="How did you hear about us" className={`grid gap-2 ${columns === 5 ? "grid-cols-5" : "grid-cols-2"}`}>
        {ATTRIBUTION_SOURCES.map((s) => {
          const selected = value.source === s.id;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange({ source: s.id, note: s.id === "other" ? value.note : "" })}
              className={`flex items-center gap-3 rounded-[10px] border bg-panel px-3 py-2.5 text-left transition-colors ${
                selected ? "border-accent ring-[3px] ring-accent-soft" : "border-line hover:border-accent"
              }`}
            >
              {"brand" in s ? (
                <IntegrationIcon id={s.brand} name={s.label} size={28} />
              ) : (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] border border-line bg-panel text-ink-2" aria-hidden>
                  {Icons[s.icon]({ size: 15 })}
                </span>
              )}
              <span className="text-[13px] leading-[1.35]">{s.label}</span>
            </button>
          );
        })}
      </div>
      {value.source === "other" && (
        <input
          autoFocus
          className="mt-3 w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent"
          placeholder="Where? A few words is plenty."
          maxLength={ATTRIBUTION_NOTE_MAX}
          value={value.note}
          onChange={(e) => onChange({ source: "other", note: e.target.value })}
        />
      )}
    </div>
  );
}

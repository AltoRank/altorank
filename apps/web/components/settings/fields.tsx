"use client";

// ---------------------------------------------------------------------------
// The form primitives the onboarding wizard and the Settings tabs share
// ---------------------------------------------------------------------------
//
// Every wizard screen is also a permanent settings tab. The two used to be
// candidates for two copies of the same form; these are the pieces both build
// from, so a label changed here changes in both places.

import { useState } from "react";
import { Button } from "@/components/ui";

export const inputClass =
  "w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-ink outline-none focus:border-accent transition-colors disabled:opacity-60";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 rounded-[8px] border border-line bg-bg px-4 py-3">
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-ink-3">{hint}</span>
      </span>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/**
 * One choice among a few, each with a label and one line of what it means.
 * Tiles, not a select, because the line matters more than the label; no
 * thumbnails, because there are no sample images to show.
 */
export function RadioTiles<T extends string>({
  name,
  value,
  options,
  onChange,
  columns = 3,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange: (v: T) => void;
  columns?: 2 | 3;
}) {
  return (
    <div role="radiogroup" className={`grid gap-2 ${columns === 2 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <label
            key={o.value}
            className={`flex cursor-pointer flex-col gap-1 rounded-[8px] border px-3 py-2.5 transition-colors ${
              selected ? "border-accent bg-panel" : "border-line bg-bg hover:border-ink-3"
            }`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={selected}
                onChange={() => onChange(o.value)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <span className="text-[13px] font-medium">{o.label}</span>
            </span>
            <span className="text-[11.5px] leading-[1.5] text-ink-3">{o.hint}</span>
          </label>
        );
      })}
    </div>
  );
}

/** Removable chips with an add box. Deleting is the main verb here. */
export function ChipList({
  items,
  onChange,
  placeholder,
  max,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  max: number;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || items.includes(v) || items.length >= max) return;
    onChange([...items, v]);
    setDraft("");
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder={placeholder}
          value={draft}
          disabled={items.length >= max}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={items.length >= max}>
          Add
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {items.map((item) => (
          <div key={item} className="flex items-start gap-2 rounded-[8px] border border-line bg-bg px-3 py-2">
            <span className="flex-1 text-[12.5px] leading-[1.5]">{item}</span>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              className="mt-0.5 cursor-pointer text-ink-3 hover:text-ink"
              onClick={() => onChange(items.filter((i) => i !== item))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A section heading with an n/max counter, for the chip lists. */
export function CountedHeading({ title, count, max }: { title: string; count: number; max: number }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <span className="font-mono text-[11px] text-ink-3">
        {count}/{max}
      </span>
    </div>
  );
}

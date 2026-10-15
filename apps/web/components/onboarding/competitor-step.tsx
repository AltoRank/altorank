"use client";

// The competitor step: suggestions the person confirms, names resolved as
// they are typed, and a size tag on every host. See
// lib/onboarding/competitor-suggestions.ts for why the small rivals matter
// more than the big ones.
//
// Optional since 2026-10-12 (UX audit #2). A required box blocked the main
// button for exactly the owners who cannot name a rival's domain - a clinic
// knows the practice down the road by name - and two of three real signups
// left on this screen. With none named, discovery still plans from what the
// business sells and the rivals its search results turn up
// (lib/keyword-research/discovery.ts). A name nothing can place is kept as a
// name (`competitorNames`), never looked up as a host.

import { useState, useTransition } from "react";
import { Button, Icons } from "@/components/ui";
import { inputClass, CountedHeading, removeButtonClass } from "@/components/settings/fields";
import { MAX_COMPETITORS } from "@/components/settings/audience-fields";
import type { CompetitorSuggestion, RivalSize } from "@/lib/onboarding/competitor-suggestions";
import { competitorEntry } from "@/lib/onboarding/wizard-rules";

export type ChosenRival = { domain: string; size: RivalSize | null };

/** What the step holds: websites (read by research), names (never looked up) and sizes. */
export type CompetitorChoice = {
  competitors: string[];
  names: string[];
  sizes: Record<string, RivalSize | null>;
};

const SOURCE_LABEL: Record<CompetitorSuggestion["source"], string> = {
  site: "named on your site",
  serp: "shows up where your customers search",
  index: "shows up for the same searches as you",
};

export function sizeLabel(size: RivalSize | null): string | null {
  return size === "bigger" ? "bigger than you" : size === "smaller" ? "smaller than you" : size === "similar" ? "your size" : null;
}

function SizeTag({ size }: { size: RivalSize | null }) {
  const label = sizeLabel(size);
  if (!label) return null;
  const tone = size === "bigger" ? "text-ink-3" : "text-ok-ink";
  return <span className={`text-[11px] ${tone}`}>{label}</span>;
}

/** The id the wizard scrolls to and focuses when this step needs a look. */
export const COMPETITOR_INPUT_ID = "wizard-competitor-input";

export function CompetitorStep({
  chosen,
  names = [],
  sizes,
  suggestions,
  loading,
  lookupFailed = false,
  onChange,
  onDraft,
  resolve,
}: {
  chosen: string[];
  /** Rivals named with no website found; shown beside the websites, never looked up. */
  names?: string[];
  /** Size per chosen domain, where known. */
  sizes: Record<string, RivalSize | null>;
  suggestions: CompetitorSuggestion[];
  /** True while suggestions are being looked up. */
  loading: boolean;
  /** The lookup for suggestions failed; said, rather than the box quietly vanishing. */
  lookupFailed?: boolean;
  onChange: (next: CompetitorChoice) => void;
  /** What is typed in the box and not yet added, so the final click can keep it. */
  onDraft?: (text: string) => void;
  /** Resolve a typed entry to a domain, or null when nothing can place it. */
  resolve: (entry: string) => Promise<ChosenRival | null>;
}) {
  const [draft, setDraftState] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [resolving, start] = useTransition();
  const count = chosen.length + names.length;
  const full = count >= MAX_COMPETITORS;
  const offered = suggestions.filter((s) => !chosen.includes(s.domain));

  function setDraft(v: string) {
    setDraftState(v);
    onDraft?.(v);
  }

  function take(domain: string, size: RivalSize | null) {
    if (full || chosen.includes(domain)) return;
    onChange({ competitors: [...chosen, domain], names, sizes: { ...sizes, [domain]: size } });
  }

  function keepName(name: string) {
    if (full || names.some((n) => n.toLowerCase() === name.toLowerCase())) return;
    onChange({ competitors: chosen, names: [...names, name], sizes });
  }

  function add() {
    const entry = competitorEntry(draft);
    if (!entry || full) return;
    setNote(null);
    start(async () => {
      const hit = await resolve(entry.text).catch(() => null);
      if (hit) {
        take(hit.domain, hit.size);
      } else if (entry.kind === "name") {
        // A name is enough. It is kept as written and used as a name; nothing
        // looks it up as a website later.
        keepName(entry.text);
        setNote(`Kept “${entry.text}” as a name. We could not find its website, and that is fine.`);
      } else {
        setNote(`No website answers at ${entry.text}. Check the spelling, or type the business name instead.`);
        return;
      }
      setDraft("");
    });
  }

  return (
    <>
      <CountedHeading title="Who do customers compare you with?" count={count} max={MAX_COMPETITORS} />
      <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-2">
        Optional. A business your customers also look at, ideally one about your size. Its name is enough.
      </p>

      {(loading || offered.length > 0) && (
        <div className="mb-3 rounded-[8px] border border-line bg-bg p-3">
          <div className="mb-2 text-[11.5px] font-medium text-ink-3">{loading ? "Looking for similar businesses…" : "Found for you"}</div>
          {offered.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {offered.map((s) => (
                <div key={s.domain} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[12.5px]">{s.domain}</span>
                  <span className="text-[11px] text-ink-3">{SOURCE_LABEL[s.source]}</span>
                  <SizeTag size={s.size} />
                  <Button size="sm" className="ml-auto" disabled={full} onClick={() => take(s.domain, s.size)}>
                    Add
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {lookupFailed && !loading && (
        <p role="status" className="mb-3 rounded-[8px] border border-line bg-bg px-3 py-2 text-[12px] leading-[1.5] text-ink-2">
          We could not look up similar businesses just now. Name one if you know it; a name is fine. Or leave this empty.
        </p>
      )}

      <div className="flex gap-2">
        <input
          id={COMPETITOR_INPUT_ID}
          aria-label="Add a business your customers compare you with"
          className={inputClass}
          placeholder="A business name or its website"
          value={draft}
          disabled={full || resolving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button onClick={add} disabled={full || resolving || !draft.trim()}>
          {resolving ? "Finding…" : "Add"}
        </Button>
      </div>
      {note && (
        <p role="status" className="mt-2 text-[12px] text-ink-2">
          {note}
        </p>
      )}

      {count > 0 && (
        <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {chosen.map((domain) => (
            <div key={domain} className="flex items-center gap-2 rounded-[8px] border border-line bg-bg py-1 pl-3 pr-1">
              <span className="min-w-0 flex-1 break-words text-[12.5px] leading-[1.5]">
                {domain}
                {sizeLabel(sizes[domain] ?? null) && <span className="ml-2 text-[11px] text-ink-3">{sizeLabel(sizes[domain] ?? null)}</span>}
              </span>
              <button
                type="button"
                aria-label={`Remove ${domain}`}
                className={removeButtonClass}
                onClick={() => onChange({ competitors: chosen.filter((c) => c !== domain), names, sizes })}
              >
                <Icons.x size={13} />
              </button>
            </div>
          ))}
          {names.map((name) => (
            <div key={`name:${name}`} className="flex items-center gap-2 rounded-[8px] border border-line bg-bg py-1 pl-3 pr-1">
              <span className="min-w-0 flex-1 break-words text-[12.5px] leading-[1.5]">
                {name}
                <span className="ml-2 text-[11px] text-ink-3">name only</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                className={removeButtonClass}
                onClick={() => onChange({ competitors: chosen, names: names.filter((n) => n !== name), sizes })}
              >
                <Icons.x size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

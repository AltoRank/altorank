"use client";

// The competitor step: suggestions the person confirms, names resolved as
// they are typed, and a size tag on every host. See
// lib/onboarding/competitor-suggestions.ts for why this field is required and
// why the small rivals matter more than the big ones.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { inputClass, CountedHeading } from "@/components/settings/fields";
import { MAX_COMPETITORS } from "@/components/settings/audience-fields";
import type { CompetitorSuggestion, RivalSize } from "@/lib/onboarding/competitor-suggestions";

export type ChosenRival = { domain: string; size: RivalSize | null };

const SOURCE_LABEL: Record<CompetitorSuggestion["source"], string> = {
  site: "named on your site",
  serp: "ranks where your buyers search",
  index: "shares your rankings",
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

export function CompetitorStep({
  chosen,
  sizes,
  suggestions,
  loading,
  onChange,
  resolve,
}: {
  chosen: string[];
  /** Size per chosen domain, where known. */
  sizes: Record<string, RivalSize | null>;
  suggestions: CompetitorSuggestion[];
  /** True while suggestions are being looked up. */
  loading: boolean;
  onChange: (next: string[], sizes: Record<string, RivalSize | null>) => void;
  /** Resolve a typed entry to a domain, or null when nothing can place it. */
  resolve: (entry: string) => Promise<ChosenRival | null>;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [resolving, start] = useTransition();
  const full = chosen.length >= MAX_COMPETITORS;
  const offered = suggestions.filter((s) => !chosen.includes(s.domain));

  function take(domain: string, size: RivalSize | null) {
    if (full || chosen.includes(domain)) return;
    onChange([...chosen, domain], { ...sizes, [domain]: size });
  }

  function add() {
    const entry = draft.trim();
    if (!entry || full) return;
    setProblem(null);
    start(async () => {
      const hit = await resolve(entry).catch(() => null);
      if (!hit) {
        setProblem(`No website found for “${entry}”. Try the domain, like competitor.com.`);
        return;
      }
      take(hit.domain, hit.size);
      setDraft("");
    });
  }

  return (
    <>
      <CountedHeading title="Who do prospects compare you with?" count={chosen.length} max={MAX_COMPETITORS} />
      <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-2">
        Name at least one. Smaller rivals are better here: a page comparing you with a rival your size is the first article that can rank.
      </p>

      {(loading || offered.length > 0) && (
        <div className="mb-3 rounded-[8px] border border-line bg-bg p-3">
          <div className="mb-2 text-[11.5px] font-medium text-ink-3">{loading ? "Looking for rivals in your search results…" : "Found for you"}</div>
          {offered.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {offered.map((s) => (
                <div key={s.domain} className="flex items-center gap-3">
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

      <div className="flex gap-2">
        <input
          className={inputClass}
          placeholder="Name or domain, e.g. revoo or revoo-app.com"
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
      {problem && <p className="mt-2 text-[12px] text-err-ink">{problem}</p>}

      {chosen.length > 0 && (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          {chosen.map((domain) => (
            <div key={domain} className="flex items-start gap-2 rounded-[8px] border border-line bg-bg px-3 py-2">
              <span className="flex-1 text-[12.5px] leading-[1.5]">
                {domain}
                {sizeLabel(sizes[domain] ?? null) && <span className="ml-2 text-[11px] text-ink-3">{sizeLabel(sizes[domain] ?? null)}</span>}
              </span>
              <button
                type="button"
                aria-label={`Remove ${domain}`}
                className="mt-0.5 cursor-pointer text-ink-3 hover:text-ink"
                onClick={() => onChange(chosen.filter((c) => c !== domain), sizes)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

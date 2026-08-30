"use client";

import { useState } from "react";
import { Icons } from "@/components/ui/icons";
import type { ArticleResearch, ResearchLayer } from "@/lib/seo/research";
import type { FactCheckReport, ExtractedClaim } from "@/lib/ai/fact-check";

// ---------------------------------------------------------------------------
// Editor sidebar: what the draft was built from, and what a human must check
// ---------------------------------------------------------------------------
//
// Both panels are read-only views over data the generation route persisted.
// They exist so the reviewer can answer two questions without leaving the page:
// "did the writer actually know anything about this keyword" and "what in here
// is a claim nobody has verified".

const INTENT_LABEL: Record<string, string> = {
  info: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
};

const INTENT_BLURB: Record<string, string> = {
  info: "Reader wants to understand something",
  commercial: "Reader is comparing options",
  transactional: "Reader is ready to act",
  navigational: "Reader wants a specific destination",
};

function LayerRow({ layer }: { layer: ResearchLayer }) {
  const label: Record<ResearchLayer["id"], string> = {
    serp: "Search results",
    related_keywords: "Related keywords",
    gsc: "Search Console",
    competitor_length: "Competitor length",
  };

  const tone =
    layer.status === "ok"
      ? "text-ink-2"
      : layer.status === "failed"
        ? "text-red-600"
        : "text-ink-4";

  return (
    <div className="flex items-baseline gap-2 text-[11.5px]">
      <span className={`font-mono ${tone}`}>
        {layer.status === "ok" ? "✓" : layer.status === "failed" ? "!" : "–"}
      </span>
      <span className="text-ink-2 min-w-[92px]">{label[layer.id]}</span>
      <span className={`flex-1 ${tone}`}>{layer.detail}</span>
    </div>
  );
}

export function ResearchPanel({ research }: { research: ArticleResearch }) {
  const [showAll, setShowAll] = useState(false);

  const { intent, confidence } = research.intent;
  const questions = research.peopleAlsoAsk;
  const related = research.relatedKeywords.filter((k) => (k.searchVolume ?? 0) > 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Intent */}
      <div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-[5px] bg-accent-soft text-accent-ink text-[11.5px] font-medium">
            {INTENT_LABEL[intent] ?? intent}
          </span>
          <span className="text-[11px] text-ink-3 font-mono">{confidence} confidence</span>
        </div>
        <div className="text-[12px] text-ink-3 mt-1.5">{INTENT_BLURB[intent]}</div>
        {!research.intent.lexicon && (
          <div className="text-[11.5px] text-ink-4 mt-1">
            No keyword lexicon for this language, so intent came from the search
            results alone.
          </div>
        )}
      </div>

      {/* Length basis */}
      <div className="text-[12px] text-ink-2">
        Target <b className="text-ink">{research.recommendedWordCount.toLocaleString()}</b> words
        <div className="text-[11.5px] text-ink-3 mt-0.5">{research.wordCountBasis}</div>
      </div>

      {/* What ranks */}
      {research.competitors.length > 0 && (
        <div>
          <div className="text-[12px] text-ink-2 mb-1.5">
            Wrote against {research.competitors.length} ranking pages
          </div>
          <div className="flex flex-col gap-1">
            {research.competitors.slice(0, showAll ? undefined : 3).map((c) => (
              <a
                key={c.url}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-baseline gap-1.5 text-[11.5px] text-ink-3 hover:text-ink transition-colors"
              >
                <Icons.externalLink size={10} className="shrink-0 translate-y-0.5" />
                <span className="truncate">{c.title}</span>
              </a>
            ))}
          </div>
          {research.competitors.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-[11.5px] text-accent-ink hover:underline mt-1"
            >
              {showAll ? "Show fewer" : `Show all ${research.competitors.length}`}
            </button>
          )}
        </div>
      )}

      {/* Questions */}
      {questions.length > 0 && (
        <div>
          <div className="text-[12px] text-ink-2 mb-1.5">
            {questions.length} questions searchers ask
          </div>
          <ul className="flex flex-col gap-1">
            {questions.slice(0, 5).map((q) => (
              <li key={q} className="text-[11.5px] text-ink-3">
                {q}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Related terms */}
      {related.length > 0 && (
        <div>
          <div className="text-[12px] text-ink-2 mb-1.5">{related.length} related terms</div>
          <div className="flex flex-wrap gap-1">
            {related.slice(0, 8).map((k) => (
              <span
                key={k.keyword}
                className="px-1.5 py-0.5 rounded-[4px] bg-panel-2 text-[11px] text-ink-2"
              >
                {k.keyword}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Existing performance */}
      {research.existingPerformance && (
        <div className="text-[12px] text-ink-2">
          Already ranking at position{" "}
          <b className="text-ink">{research.existingPerformance.position}</b> for this
          query
          <div className="text-[11.5px] text-ink-3 mt-0.5">
            {research.existingPerformance.impressions.toLocaleString()} impressions,{" "}
            {research.existingPerformance.clicks.toLocaleString()} clicks in 90 days
          </div>
        </div>
      )}

      {/* Provenance. Deliberately always shown: "no competitor covers this" and
          "we could not read the competitors" look identical without it. */}
      <div className="pt-3 border-t border-line flex flex-col gap-1">
        {research.layers.map((l) => (
          <LayerRow key={l.id} layer={l} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<ExtractedClaim["status"], string> = {
  unsourced: "No source",
  needs_verification: "Verify source",
  corroborated: "Seen elsewhere",
};

function ClaimRow({
  claim,
  onLocate,
}: {
  claim: ExtractedClaim;
  onLocate?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const tone =
    claim.severity === "high"
      ? "border-red-300 bg-red-50"
      : "border-amber-200 bg-amber-50";

  return (
    <div className={`rounded-[6px] border px-2.5 py-2 ${tone}`}>
      <div className="flex items-center gap-2">
        <code className="text-[12px] font-semibold text-ink">{claim.text}</code>
        <span className="text-[10.5px] font-mono uppercase tracking-[0.06em] text-ink-3">
          {STATUS_LABEL[claim.status]}
        </span>
        <div className="flex-1" />
        {onLocate && (
          <button
            type="button"
            onClick={() => onLocate(claim.text)}
            className="text-[11px] text-accent-ink hover:underline"
            title="Select this in the article"
          >
            Find
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-[11.5px] text-ink-2 mt-1 leading-[1.5]"
      >
        {open ? claim.sentence : `${claim.sentence.slice(0, 90)}${claim.sentence.length > 90 ? "…" : ""}`}
      </button>

      {open && <div className="text-[11.5px] text-ink-3 mt-1.5">{claim.note}</div>}
    </div>
  );
}

export function FactCheckPanel({
  report,
  onLocate,
}: {
  report: FactCheckReport;
  onLocate?: (text: string) => void;
}) {
  if (report.verdict === "clean") {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
        <Icons.check size={13} />
        {report.summary}
      </div>
    );
  }

  // Highest severity first: an unsourced number is what stops a publish.
  const ordered = [...report.claims].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1,
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12.5px] text-ink-2">{report.summary}</div>
      {ordered.map((c) => (
        <ClaimRow key={c.id} claim={c} onLocate={onLocate} />
      ))}
      <div className="text-[11px] text-ink-4 leading-[1.5] mt-1">
        These are claims a reader would expect a source for. The check finds
        unattributed figures; it cannot tell you whether a figure is true.
      </div>
    </div>
  );
}

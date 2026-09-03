"use client";

import { useState } from "react";
import { Icons } from "@/components/ui/icons";
import { StatusPill } from "@/components/ui/status-pill";
import {
  GROUP_LABEL,
  type ArticleAudit,
  type AuditGroup,
  type AuditItem,
  type AuditStatus,
  type LinkRef,
} from "@/lib/seo/article-audit";

// ---------------------------------------------------------------------------
// Editor sidebar: what the draft is missing, and where
// ---------------------------------------------------------------------------
//
// Renders `auditArticle` output. Every finding that refers to text in the
// document carries the fragments it refers to, and each one is a button that
// selects the fragment in the editor, so the panel is a to-do list rather
// than a report. Recomputed from the editor as the user types; nothing here
// is persisted, and nothing here calls a model.

const GROUP_ORDER: AuditGroup[] = ["links", "sources", "structure", "metadata", "media", "trust"];
const STATUS_ORDER: Record<AuditStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

const DOT: Record<AuditStatus, string> = {
  fail: "bg-err",
  warn: "bg-warn",
  pass: "bg-ok",
  info: "bg-ink-4",
};

const VERDICT: Record<ArticleAudit["verdict"], { status: string; label: string; blurb: string }> = {
  "needs-work": {
    status: "error",
    label: "Needs work",
    blurb: "Something here is a defect a reader or crawler will hit. Fix the red items before approving.",
  },
  review: {
    status: "review",
    label: "Review",
    blurb: "Nothing broken, but there are things worth a look before this goes out.",
  },
  ready: {
    status: "live",
    label: "Clean",
    blurb: "Nothing the audit can find. The grey items are what it cannot check for you.",
  },
};

type Props = {
  audit: ArticleAudit;
  /** Select a fragment of text in the editor. */
  onLocate?: (needle: string) => void;
};

export function AuditPanel({ audit, onLocate }: Props) {
  const v = VERDICT[audit.verdict];
  const toFix = audit.counts.fail + audit.counts.warn;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-2.5">
          <StatusPill status={v.status} label={v.label} />
          <span className="font-mono text-[11.5px] tabular-nums text-ink-3">
            {audit.counts.fail} to fix · {audit.counts.warn} to review
          </span>
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{v.blurb}</p>
      </div>

      {GROUP_ORDER.map((group) => {
        const items = audit.items
          .filter((i) => i.group === group)
          .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
        if (items.length === 0) return null;
        const open = items.filter((i) => i.status === "fail" || i.status === "warn").length;
        return (
          <section key={group} className="border-t border-line-soft pt-3">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-[12px] text-ink-3">{GROUP_LABEL[group]}</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-4">
                {open === 0 ? "clear" : `${open} open`}
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} onLocate={onLocate} />
              ))}
            </ul>
            {group === "links" && <LinkInventory links={audit.links} onLocate={onLocate} />}
          </section>
        );
      })}

      <p className="text-[11px] leading-relaxed text-ink-4">
        Recomputed from the text in the editor as you type. No model call, no
        network: it cannot tell whether a cited page exists or says what the
        draft says it does, so {toFix === 0 ? "the grey items remain" : "those remain"} yours to
        check.
      </p>
    </div>
  );
}

function ItemRow({ item, onLocate }: { item: AuditItem; onLocate?: (needle: string) => void }) {
  const needles = (item.locate ?? []).filter(Boolean);
  return (
    <li className="flex gap-2 text-[12px] leading-snug">
      <span aria-hidden="true" className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[item.status]}`} />
      <div className="flex-1 min-w-0">
        <span className={item.status === "pass" || item.status === "info" ? "text-ink-3" : "text-ink"}>
          {item.label}
        </span>
        <span className="sr-only">
          {item.status === "fail"
            ? ": needs fixing"
            : item.status === "warn"
              ? ": needs review"
              : item.status === "pass"
                ? ": passed"
                : ": note"}
        </span>
        <span className="block text-[11.5px] text-ink-4">{item.detail}</span>
        {needles.length > 0 && onLocate && item.status !== "pass" && (
          <div className="mt-1 flex flex-wrap gap-1">
            {needles.map((needle) => (
              <button
                key={needle}
                type="button"
                onClick={() => onLocate(needle)}
                title="Select this in the article"
                className="max-w-full truncate rounded-[4px] bg-panel-2 px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-line hover:text-ink transition-colors"
              >
                {needle}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The links themselves, so "3 outbound links" can be checked against what
 * they actually point at without hunting through the document.
 */
function LinkInventory({ links, onLocate }: { links: LinkRef[]; onLocate?: (needle: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const listed = links.filter((l) => l.kind === "internal" || l.kind === "external");
  if (listed.length === 0) return null;
  const visible = showAll ? listed : listed.slice(0, 6);

  return (
    <div className="mt-3 flex flex-col gap-1">
      {visible.map((l, i) => (
        <div key={`${l.href}-${i}`} className="flex items-baseline gap-1.5 text-[11.5px] min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 w-[52px] shrink-0">
            {l.kind === "internal" ? "internal" : "out"}
          </span>
          {onLocate ? (
            <button
              type="button"
              onClick={() => onLocate(l.anchor)}
              className="truncate text-ink-2 hover:text-ink text-left"
              title="Select this in the article"
            >
              {l.anchor || "(no text)"}
            </button>
          ) : (
            <span className="truncate text-ink-2">{l.anchor || "(no text)"}</span>
          )}
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 text-ink-4 hover:text-ink"
            title={l.href}
            aria-label={`Open ${l.href}`}
          >
            <Icons.externalLink size={10} />
          </a>
        </div>
      ))}
      {listed.length > 6 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="text-left text-[11.5px] text-accent-ink hover:underline mt-0.5"
        >
          {showAll ? "Show fewer" : `Show all ${listed.length}`}
        </button>
      )}
    </div>
  );
}

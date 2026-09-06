"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Chip } from "@/components/ui";
import { scheduleCandidates, storeCandidates } from "@/app/actions/keyword-research";
import { funnelLine, isEasyWin } from "@/lib/keyword-research/funnel";
import type { PlanCapacity, ResearchCandidate, ResearchFunnel } from "@/lib/keyword-research/types";

interface ProposalTableProps {
  workspaceId: string;
  candidates: ResearchCandidate[];
  funnel: ResearchFunnel | null;
  runId?: string | null;
  note?: string | null;
  trace?: string[];
  /** Hide the Store action (the Stored tab already is the shelf). */
  compact?: boolean;
  onCapacity?: (c: PlanCapacity) => void;
  onChanged?: () => void;
}

/** A metric, or an honest dash. Never 0 for unknown. */
function Metric({ value, fixed }: { value: number | null; fixed?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-ink-4" title="No data from the keyword provider">—</span>;
  }
  return <>{fixed !== undefined ? value.toFixed(fixed) : value.toLocaleString()}</>;
}

function DifficultyBar({ value }: { value: number | null }) {
  const known = typeof value === "number";
  const color = !known ? "var(--line)" : value < 25 ? "var(--ok)" : value < 50 ? "var(--warn)" : "var(--err)";
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-[44px] h-[5px] bg-panel-2 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: known ? `${value}%` : "0%", background: color }} />
      </div>
      <span className={`font-mono text-[11px] w-5 text-right ${known ? "" : "text-ink-4"}`}>{known ? value : "—"}</span>
    </div>
  );
}

/**
 * The end of every research path: a table a person reads and acts on.
 *
 * Rows arrive selected, because the default action after "propose 5" is to
 * take the 5. Nothing leaves this component without a click on Schedule or
 * Store, and after either the row says what happened to it.
 */
export function ProposalTable({ workspaceId, candidates, funnel, runId = null, note, trace, compact, onCapacity, onChanged }: ProposalTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((c) => c.term)));
  const [done, setDone] = useState<Map<string, "scheduled" | "stored" | "refused">>(new Map());
  const [pending, setPending] = useState<"schedule" | "store" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduledCount, setScheduledCount] = useState(0);

  // A fresh result resets the selection; the rows are different rows.
  useEffect(() => {
    setSelected(new Set(candidates.map((c) => c.term)));
    setDone(new Map());
    setMessage(null);
    setScheduledCount(0);
  }, [candidates]);

  const actionable = candidates.filter((c) => selected.has(c.term) && !done.has(c.term));

  function toggle(term: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });
  }

  async function act(kind: "schedule" | "store") {
    if (!actionable.length) return;
    setPending(kind);
    setMessage(null);
    try {
      if (kind === "schedule") {
        const r = await scheduleCandidates(workspaceId, actionable, runId);
        setScheduledCount((n) => n + r.scheduled);
        setDone((prev) => {
          const next = new Map(prev);
          actionable.forEach((c, i) => next.set(c.term, i < r.scheduled + r.alreadyPlanned ? "scheduled" : "refused"));
          return next;
        });
        onCapacity?.(r.capacity);
        const parts = [`${r.scheduled} scheduled`];
        if (r.alreadyPlanned) parts.push(`${r.alreadyPlanned} already on the calendar`);
        if (r.refused) parts.push(`${r.refused} refused: the calendar holds ${r.capacity.cap} keywords and it is full`);
        setMessage(parts.join(" · "));
      } else {
        const r = await storeCandidates(workspaceId, actionable);
        setDone((prev) => {
          const next = new Map(prev);
          actionable.forEach((c) => next.set(c.term, "stored"));
          return next;
        });
        setMessage(`${r.stored} stored${r.alreadyTracked ? ` · ${r.alreadyTracked} already tracked, left as they were` : ""}`);
      }
      onChanged?.();
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  if (!candidates.length) {
    return (
      <div className="rounded-lg border border-dashed border-line px-4 py-6 text-[13px] text-ink-3">
        {note ?? "Nothing to propose."}
        {funnel && <div className="mt-2 font-mono text-[11px] text-ink-4">{funnelLine(funnel)}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {trace && trace.length > 0 && (
        <div className="font-mono text-[11px] text-ink-3 leading-relaxed">{trace.join("  →  ")}</div>
      )}
      {note && <div className="text-[12.5px] text-warn-ink bg-warn-soft rounded-md px-3 py-2">{note}</div>}

      <div className="rounded-lg border border-line overflow-hidden">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="bg-panel">
              <th className="w-8 px-2.5 py-2 border-b border-line">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={actionable.length > 0 && candidates.filter((c) => !done.has(c.term)).every((c) => selected.has(c.term))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(candidates.map((c) => c.term)) : new Set())}
                />
              </th>
              {["Keyword", "Vol", "KD", "CPC", "Intent", ""].map((h, i) => (
                <th key={h || i} className={`font-medium text-[10.5px] text-ink-3 uppercase tracking-[0.06em] px-2.5 py-2 border-b border-line ${h === "Vol" || h === "KD" || h === "CPC" ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => {
              const state = done.get(c.term);
              const tracked = c.existingStatus && c.existingStatus !== "new" && c.existingStatus !== "stored";
              return (
                <tr key={c.term} className={`hover:[&>td]:bg-panel ${state ? "opacity-60" : ""}`}>
                  <td className="px-2.5 py-2 border-b border-line-soft">
                    <input type="checkbox" aria-label={`Select ${c.term}`} checked={selected.has(c.term) && !state} disabled={Boolean(state)} onChange={() => toggle(c.term)} />
                  </td>
                  <td className="px-2.5 py-2 border-b border-line-soft">
                    <div className="font-mono text-[12.5px] text-ink font-medium">{c.term}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span>{c.origin}</span>
                      {tracked && <span className="text-ink-4">· already {c.existingStatus}</span>}
                      {isEasyWin(c) && !state && (
                        <span className="inline-flex px-1.5 rounded-full bg-ok-soft text-ok-ink text-[10.5px] font-medium" title="Volume ≥ 100 and difficulty ≤ 30">Easy win</span>
                      )}
                      {state && (
                        <span className={`inline-flex px-1.5 rounded-full text-[10.5px] font-medium ${state === "refused" ? "bg-warn-soft text-warn-ink" : "bg-panel-2 text-ink-2"}`}>
                          {state === "scheduled" ? "Scheduled" : state === "stored" ? "Stored" : "Calendar full"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-line-soft text-right font-mono text-xs text-ink-2"><Metric value={c.volume} /></td>
                  <td className="px-2.5 py-2 border-b border-line-soft"><DifficultyBar value={c.difficulty} /></td>
                  <td className="px-2.5 py-2 border-b border-line-soft text-right font-mono text-xs text-ink-2"><Metric value={c.cpc} fixed={2} /></td>
                  <td className="px-2.5 py-2 border-b border-line-soft"><Chip label={c.intent} soft /></td>
                  <td className="border-b border-line-soft" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[11px] text-ink-3 flex-1 min-w-[160px]">
          {message ?? (funnel ? funnelLine(funnel, scheduledCount) : `${candidates.length} proposed`)}
        </span>
        {!compact && (
          <Button size="sm" disabled={!actionable.length || pending !== null} onClick={() => act("store")}>
            {pending === "store" ? "Storing…" : `Store${actionable.length ? ` (${actionable.length})` : ""}`}
          </Button>
        )}
        <Button size="sm" variant="accent" disabled={!actionable.length || pending !== null} onClick={() => act("schedule")}>
          {pending === "schedule" ? "Scheduling…" : `Schedule selected${actionable.length ? ` (${actionable.length})` : ""}`}
        </Button>
      </div>
    </div>
  );
}

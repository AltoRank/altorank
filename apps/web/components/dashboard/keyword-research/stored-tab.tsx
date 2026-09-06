"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Chip } from "@/components/ui";
import { scheduleStored, type ResearchContext } from "@/app/actions/keyword-research";
import type { PlanCapacity } from "@/lib/keyword-research/types";

interface StoredTabProps {
  workspaceId: string;
  ctx: ResearchContext;
  onCapacity: (c: PlanCapacity) => void;
  onChanged: () => void;
}

export function StoredTab({ workspaceId, ctx, onCapacity, onChanged }: StoredTabProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows = ctx.stored;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function schedule() {
    if (!selected.size) return;
    setPending(true);
    setMessage(null);
    try {
      const r = await scheduleStored(workspaceId, [...selected]);
      onCapacity(r.capacity);
      const parts = [`${r.scheduled} scheduled`];
      if (r.refused) parts.push(`${r.refused} refused: the calendar holds ${r.capacity.cap} keywords and it is full`);
      setMessage(parts.join(" · "));
      setSelected(new Set());
      onChanged();
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Scheduling failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">Keywords you researched earlier but did not schedule.</p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13px] text-ink-3">No stored keywords yet.</div>
      ) : (
        <>
          <div className="rounded-lg border border-line overflow-hidden">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="bg-panel">
                  <th className="w-8 px-2.5 py-2 border-b border-line">
                    <input
                      type="checkbox"
                      aria-label="Select all stored"
                      checked={selected.size === rows.length && rows.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                    />
                  </th>
                  {["Keyword", "Vol", "KD", "Intent"].map((h) => (
                    <th key={h} className={`font-medium text-[10.5px] text-ink-3 uppercase tracking-[0.06em] px-2.5 py-2 border-b border-line ${h === "Vol" || h === "KD" ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id} className="hover:[&>td]:bg-panel">
                    <td className="px-2.5 py-2 border-b border-line-soft">
                      <input type="checkbox" aria-label={`Select ${k.term}`} checked={selected.has(k.id)} onChange={() => toggle(k.id)} />
                    </td>
                    <td className="px-2.5 py-2 border-b border-line-soft font-mono text-[12.5px] text-ink font-medium">{k.term}</td>
                    <td className="px-2.5 py-2 border-b border-line-soft text-right font-mono text-xs text-ink-2">{k.volume === null ? <span className="text-ink-4">—</span> : k.volume.toLocaleString()}</td>
                    <td className="px-2.5 py-2 border-b border-line-soft text-right font-mono text-xs text-ink-2">{k.difficulty === null ? <span className="text-ink-4">—</span> : k.difficulty}</td>
                    <td className="px-2.5 py-2 border-b border-line-soft"><Chip label={k.intent} soft /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-ink-3 flex-1">{message ?? `${rows.length} stored`}</span>
            <Button size="sm" variant="accent" disabled={!selected.size || pending} onClick={schedule}>
              {pending ? "Scheduling…" : `Schedule selected${selected.size ? ` (${selected.size})` : ""}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Button, Chip } from "@/components/ui";
import { runGenerate, saveKeywordInstructions, type ResearchContext } from "@/app/actions/keyword-research";
import { capacityLine } from "@/lib/keyword-research/funnel";
import { GENERATE_DEFAULT, GENERATE_MAX } from "@/lib/keyword-research/pipeline";
import { KEYWORD_INSTRUCTIONS_MAX } from "@/lib/keyword-research/instructions";
import type { PlanCapacity, ResearchResult, ResearchSource } from "@/lib/keyword-research/types";
import { ProposalTable } from "./proposal-table";

interface GenerateTabProps {
  workspaceId: string;
  ctx: ResearchContext;
  handoff: { result: ResearchResult; title: string } | null;
  onCapacity: (c: PlanCapacity) => void;
  onChanged: () => void;
  onInstructionsSaved: (text: string) => void;
}

const SOURCES: Array<{ id: ResearchSource; label: string }> = [
  { id: "both", label: "Competitors & audiences" },
  { id: "competitors", label: "Competitors only" },
  { id: "audiences", label: "Audiences only" },
];

function MultiSelect({ label, options, value, onChange, empty }: { label: string; options: string[]; value: Set<string>; onChange: (v: Set<string>) => void; empty: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
        {options.length > 0 && (
          <button type="button" className="text-[11.5px] text-ink-3 hover:text-ink cursor-pointer" onClick={() => onChange(value.size === options.length ? new Set() : new Set(options))}>
            {value.size === options.length ? "Clear" : "Select all"}
          </button>
        )}
      </div>
      {options.length === 0 ? (
        <div className="text-[12.5px] text-ink-3">{empty}</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <Chip
              key={o}
              label={o}
              active={value.has(o)}
              soft={!value.has(o)}
              onClick={() => {
                const next = new Set(value);
                if (next.has(o)) next.delete(o);
                else next.add(o);
                onChange(next);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GenerateTab({ workspaceId, ctx, handoff, onCapacity, onChanged, onInstructionsSaved }: GenerateTabProps) {
  const [source, setSource] = useState<ResearchSource>("both");
  const [competitors, setCompetitors] = useState<Set<string>>(() => new Set(ctx.profile.competitors));
  const [audiences, setAudiences] = useState<Set<string>>(() => new Set(ctx.profile.audiences));
  const [count, setCount] = useState(GENERATE_DEFAULT);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ result: ResearchResult; title: string } | null>(handoff);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(ctx.instructions);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (handoff) setResult(handoff);
  }, [handoff]);

  const needsCompetitors = source !== "audiences";
  const needsAudiences = source !== "competitors";
  const canRun =
    !running &&
    ctx.providerReady &&
    ((needsCompetitors && competitors.size > 0) || (needsAudiences && audiences.size > 0));

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await runGenerate(workspaceId, { source, competitors: [...competitors], audiences: [...audiences], count });
      setResult({ result: r, title: "Generated" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed.");
    } finally {
      setRunning(false);
    }
  }

  async function saveInstructions() {
    setSaving(true);
    try {
      await saveKeywordInstructions(workspaceId, instructions);
      onInstructionsSaved(instructions.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-ink-2">
        Researches keywords from your competitors and target audiences, then schedules them on your calendar.
      </p>

      {!ctx.providerReady && (
        <div className="text-[12.5px] text-warn-ink bg-warn-soft rounded-md px-3 py-2">
          Keyword metrics need DataForSEO credentials on the server. Set DATAFORSEO_API_KEY to research.
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-2">Source</span>
        <div className="flex flex-wrap gap-1.5">
          {SOURCES.map((s) => (
            <Chip key={s.id} label={s.label} active={source === s.id} soft={source !== s.id} onClick={() => setSource(s.id)} />
          ))}
        </div>
      </div>

      {needsCompetitors && (
        <MultiSelect label="Competitors" options={ctx.profile.competitors} value={competitors} onChange={setCompetitors} empty="No competitors in the business profile yet. Add them in onboarding, or use Audiences only." />
      )}
      {needsAudiences && (
        <MultiSelect label="Target audiences" options={ctx.profile.audiences} value={audiences} onChange={setAudiences} empty="No audiences in the business profile yet. Add them in onboarding, or use Competitors only." />
      )}
      {needsAudiences && !ctx.modelReady && audiences.size > 0 && (
        <div className="text-[12px] text-ink-3">Audience research proposes seed phrases with a model and needs ANTHROPIC_API_KEY; competitors still work without it.</div>
      )}

      <div className="flex items-end gap-4 flex-wrap">
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-2">Number of keywords</span>
          <input
            type="number"
            min={1}
            max={GENERATE_MAX}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(GENERATE_MAX, Number(e.target.value) || GENERATE_DEFAULT)))}
            className="w-24 px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors font-mono"
          />
        </label>
        <div className="flex-1 min-w-[180px] font-mono text-[11.5px] text-ink-3 pb-2.5">{capacityLine(ctx.capacity)}</div>
        <Button variant="accent" disabled={!canRun} onClick={run}>
          {running ? "Researching…" : "Research"}
        </Button>
      </div>

      {error && <div className="text-[12.5px] text-err-ink bg-err-soft rounded-md px-3 py-2">{error}</div>}

      {result && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-ink-2">{result.title}</div>
          <ProposalTable
            workspaceId={workspaceId}
            candidates={result.result.candidates}
            funnel={result.result.funnel}
            runId={result.result.runId}
            note={result.result.note}
            trace={result.result.trace}
            onCapacity={onCapacity}
            onChanged={onChanged}
          />
        </div>
      )}

      <div className="border-t border-line pt-3 text-[12.5px] text-ink-3">
        {editing ? (
          <div className="flex flex-col gap-2">
            <span className="font-medium text-ink-2">Keyword instructions</span>
            <textarea
              value={instructions}
              maxLength={KEYWORD_INSTRUCTIONS_MAX}
              onChange={(e) => setInstructions(e.target.value)}
              rows={4}
              placeholder='e.g. "We only sell in the UK. Never target our own brand name. Prefer how-to questions."'
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => { setInstructions(ctx.instructions); setEditing(false); }}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={saving} onClick={saveInstructions}>{saving ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        ) : (
          <span>
            Want to guide the research?{" "}
            <button type="button" className="text-ink underline underline-offset-2 cursor-pointer" onClick={() => setEditing(true)}>
              {ctx.instructions ? "Edit keyword instructions" : "Add keyword instructions"}
            </button>
            {ctx.instructions && <span className="ml-1.5 text-ink-4">· in use for every run</span>}
          </span>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button, Chip } from "@/components/ui";
import { runFind, runImport, type ResearchContext } from "@/app/actions/keyword-research";
import { parseTermList } from "@/lib/keyword-research/funnel";
import type { PlanCapacity, ResearchResult } from "@/lib/keyword-research/types";
import { ProposalTable } from "./proposal-table";

interface AddTabProps {
  workspaceId: string;
  ctx: ResearchContext;
  onCapacity: (c: PlanCapacity) => void;
  onChanged: () => void;
}

export function AddTab({ workspaceId, ctx, onCapacity, onChanged }: AddTabProps) {
  const [mode, setMode] = useState<"find" | "import">("find");
  const [term, setTerm] = useState("");
  const [list, setList] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listCount = parseTermList(list).length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResult(mode === "find" ? await runFind(workspaceId, term) : await runImport(workspaceId, list));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed.");
    } finally {
      setRunning(false);
    }
  }

  const input = "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        <Chip label="Find" active={mode === "find"} soft={mode !== "find"} onClick={() => setMode("find")} />
        <Chip label="Import list" active={mode === "import"} soft={mode !== "import"} onClick={() => setMode("import")} />
      </div>

      {!ctx.providerReady && (
        <div className="text-[12.5px] text-warn-ink bg-warn-soft rounded-md px-3 py-2">
          Keyword metrics need DataForSEO credentials on the server. Set DATAFORSEO_API_KEY to look terms up.
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2.5">
        {mode === "find" ? (
          <>
            <p className="text-[13px] text-ink-2">Live metrics for one term and up to 10 related searches.</p>
            <div className="flex gap-2">
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Enter a word or phrase" className={`${input} flex-1`} />
              <Button type="submit" variant="accent" disabled={running || !ctx.providerReady || !term.trim()}>
                {running ? "Looking up…" : "Find"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[13px] text-ink-2">Metrics for your own list, looked up in one batch.</p>
            <textarea value={list} onChange={(e) => setList(e.target.value)} rows={6} placeholder="Enter keywords separated by commas or new lines" className={input} />
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11.5px] text-ink-3 flex-1">{listCount ? `${listCount} term${listCount === 1 ? "" : "s"}` : ""}</span>
              <Button type="submit" variant="accent" disabled={running || !ctx.providerReady || listCount === 0}>
                {running ? "Looking up…" : "Look up"}
              </Button>
            </div>
          </>
        )}
      </form>

      {error && <div className="text-[12.5px] text-err-ink bg-err-soft rounded-md px-3 py-2">{error}</div>}

      {result && (
        <ProposalTable
          workspaceId={workspaceId}
          candidates={result.candidates}
          funnel={result.funnel}
          runId={result.runId}
          note={result.note}
          trace={result.trace}
          onCapacity={onCapacity}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Drawer, TabRow } from "@/components/ui";
import { loadResearchContext, type ResearchContext } from "@/app/actions/keyword-research";
import { capacityLine } from "@/lib/keyword-research/funnel";
import type { PlanCapacity, ResearchResult } from "@/lib/keyword-research/types";
import { GenerateTab } from "./generate-tab";
import { AddTab } from "./add-tab";
import { StoredTab } from "./stored-tab";
import { ChatTab } from "./chat-tab";

type TabId = "generate" | "add" | "stored" | "chat";

interface ResearchDrawerProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A playbook result handed over from the Playbooks dialog. */
  handoff: { result: ResearchResult; title: string } | null;
}

export function ResearchDrawer({ workspaceId, open, onOpenChange, handoff }: ResearchDrawerProps) {
  const [tab, setTab] = useState<TabId>("generate");
  const [ctx, setCtx] = useState<ResearchContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCtx(await loadResearchContext(workspaceId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this site.");
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  useEffect(() => {
    if (handoff) setTab("generate");
  }, [handoff]);

  const onCapacity = useCallback((capacity: PlanCapacity) => {
    setCtx((prev) => (prev ? { ...prev, capacity } : prev));
  }, []);

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Research keywords"
      description={ctx ? `${ctx.workspace.name || ctx.workspace.domain} · ${capacityLine(ctx.capacity)}` : "Loading…"}
    >
      <TabRow
        className="px-5"
        activeTab={tab}
        onChange={(id) => setTab(id as TabId)}
        tabs={[
          { id: "generate", label: "Generate" },
          { id: "add", label: "Add" },
          { id: "stored", label: "Stored", count: ctx?.stored.length },
          { id: "chat", label: "Chat" },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 scroll">
        {error && <div className="text-[13px] text-err-ink bg-err-soft rounded-md px-3 py-2 mb-3">{error}</div>}
        {!ctx && !error && <div className="text-[13px] text-ink-3">Loading this site's profile…</div>}
        {ctx && tab === "generate" && (
          <GenerateTab workspaceId={workspaceId} ctx={ctx} handoff={handoff} onCapacity={onCapacity} onChanged={reload} onInstructionsSaved={(text) => setCtx({ ...ctx, instructions: text })} />
        )}
        {ctx && tab === "add" && <AddTab workspaceId={workspaceId} ctx={ctx} onCapacity={onCapacity} onChanged={reload} />}
        {ctx && tab === "stored" && <StoredTab workspaceId={workspaceId} ctx={ctx} onCapacity={onCapacity} onChanged={reload} />}
        {ctx && tab === "chat" && <ChatTab workspaceId={workspaceId} ctx={ctx} onCapacity={onCapacity} onChanged={reload} />}
      </div>
    </Drawer>
  );
}

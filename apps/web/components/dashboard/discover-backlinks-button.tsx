"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { fetchBacklinks } from "@/app/actions/seo";
import type { Workspace } from "@/lib/types";

/** One click, one DataForSEO call: who links to this workspace's domain now. */
export function DiscoverBacklinksButton({ workspaces }: { workspaces: Pick<Workspace, "id" | "name">[] }) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [pending, start] = useTransition();
  if (!workspaces.length) return null;
  return (
    <div className="flex items-center gap-2">
      {workspaces.length > 1 && (
        <select
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          className="h-9 rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink"
          aria-label="Workspace"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      )}
      <Button
        disabled={pending || !workspaceId}
        onClick={() =>
          start(async () => {
            try {
              const r = await fetchBacklinks(workspaceId);
              toast.success(
                `${r.fetched} referring domains stored` +
                  (r.total !== null ? ` of ${r.total.toLocaleString()} links in the index` : "") +
                  (r.lost ? `, ${r.lost} marked lost` : ""),
              );
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Could not fetch backlinks");
            }
          })
        }
      >
        {pending ? "Checking…" : "Discover backlinks"}
      </Button>
    </div>
  );
}

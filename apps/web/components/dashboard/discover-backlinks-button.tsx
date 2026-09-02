"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { fetchBacklinks } from "@/app/actions/seo";
import type { Workspace } from "@/lib/types";

/** One click, one DataForSEO call: who links to this workspace's domain now. */
/**
 * Acts on the workspace the sidebar is scoped to. It used to carry its own
 * dropdown, which sat next to the filter dropdown and the sidebar switcher:
 * three controls for one idea (2026-09-02).
 */
export function DiscoverBacklinksButton({ workspaces, scopedId }: { workspaces: Pick<Workspace, "id" | "name">[]; scopedId?: string | null }) {
  const workspaceId = scopedId ?? workspaces[0]?.id ?? "";
  const [pending, start] = useTransition();
  if (!workspaces.length) return null;
  const only = workspaces.find((w) => w.id === workspaceId);
  return (
    <div className="flex items-center gap-2">
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
        {pending ? "Checking…" : only && workspaces.length > 1 ? `Discover for ${only.name}` : "Discover backlinks"}
      </Button>
    </div>
  );
}

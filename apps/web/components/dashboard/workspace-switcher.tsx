"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { Avatar, Icons } from "@/components/ui";

/**
 * The scope control. Sits above the navigation because it changes what every
 * item below it means: Articles, Keywords, Backlinks and the rest are about
 * the selected site, not about all of them at once.
 */
export function WorkspaceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { workspaces, active, setActiveId } = useWorkspace();
  const router = useRouter();
  const [pending, start] = useTransition();

  if (!workspaces.length) return null;

  function choose(id: string) {
    setActiveId(id);
    // Server components read the cookie, so the page has to be re-rendered.
    start(() => router.refresh());
  }

  if (collapsed) {
    return (
      <div className="flex justify-center border-b border-line py-2.5">
        <Avatar initials={active?.initials ?? "AL"} color={active?.color ?? "av-c1"} size="sm" />
      </div>
    );
  }

  return (
    <div className="border-b border-line px-3 py-2.5">
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
        Workspace
      </label>
      <div className="relative">
        <select
          value={active?.id ?? "all"}
          onChange={(e) => choose(e.target.value)}
          disabled={pending}
          aria-label="Choose which workspace to view"
          className="w-full cursor-pointer appearance-none rounded-[7px] border border-line bg-panel py-1.5 pl-2.5 pr-7 text-[13px] font-medium text-ink disabled:opacity-60"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
          {workspaces.length > 1 && <option value="all">All workspaces</option>}
        </select>
        <Icons.caretDown size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3" />
      </div>
      {active?.domain && (
        <div className="mt-1 truncate font-mono text-[10.5px] text-ink-3">{active.domain}</div>
      )}
    </div>
  );
}

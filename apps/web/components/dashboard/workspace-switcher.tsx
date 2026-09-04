"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { Avatar, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";
import { siteSlotsLabel, siteSlotsRemaining, type SiteAllowance } from "@/lib/workspaces/slots";

/**
 * Per-site status, from `workspaces.status`. The labels match STATUS_META in
 * lib/constants.ts so the dot here and the pill on /workspaces agree.
 */
const STATUS_DOT: Record<Workspace["status"], { cls: string; label: string }> = {
  on: { cls: "bg-ok", label: "Publishing" },
  review: { cls: "bg-warn", label: "Review" },
  paused: { cls: "bg-ink-4", label: "Paused" },
  setup: { cls: "bg-transparent border border-ink-4", label: "Setup" },
};

function StatusDot({ status }: { status: Workspace["status"] }) {
  const meta = STATUS_DOT[status] ?? STATUS_DOT.setup;
  return (
    <span
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className={cn("inline-block w-2 h-2 rounded-full shrink-0", meta.cls)}
    />
  );
}

/**
 * The scope control. Sits above the navigation because it changes what every
 * item below it means: Articles, Keywords, Backlinks and the rest are about
 * the selected site, not about all of them at once.
 *
 * A native <select> did the job but could only show a name. This shows the
 * current site with its domain and status, the others the same way, and how
 * many more the plan allows, which is the question people had when they came
 * looking for the Add button.
 */
export function WorkspaceSwitcher({
  collapsed = false,
  allowance = null,
}: {
  collapsed?: boolean;
  /** Null when unknown; the footer then shows a dash rather than a number. */
  allowance?: SiteAllowance;
}) {
  const { workspaces, active, setActiveId } = useWorkspace();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!workspaces.length) return null;

  function choose(id: string) {
    setOpen(false);
    if (id === active?.id) return;
    setActiveId(id);
    // Server components read the cookie, so the page has to be re-rendered.
    start(() => router.refresh());
  }

  const remaining = siteSlotsRemaining(allowance);
  const canAdd = remaining === null || remaining > 0;

  if (collapsed) {
    return (
      <div
        className="flex justify-center border-b border-line py-2.5"
        title={active ? `${active.name} · ${active.domain}` : undefined}
      >
        <span className="relative">
          <Avatar initials={active?.initials ?? "AL"} color={active?.color ?? "av-c1"} size="sm" />
          {active && (
            <span className="absolute -right-[3px] -bottom-[3px] rounded-full border-2 border-panel">
              <StatusDot status={active.status} />
            </span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="border-b border-line px-3 py-2.5" ref={ref}>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
        Site
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={pending}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Choose which site to view"
          data-testid="workspace-switcher"
          className={cn(
            "w-full flex items-center gap-2 rounded-[7px] border border-line bg-bg py-1.5 pl-2 pr-2 text-left",
            "hover:bg-panel-2 disabled:opacity-60 cursor-pointer",
          )}
        >
          <Avatar initials={active?.initials ?? "AL"} color={active?.color ?? "av-c1"} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-ink">{active?.name}</span>
              {active && <StatusDot status={active.status} />}
            </span>
            {active?.domain && (
              <span className="block truncate font-mono text-[10.5px] text-ink-3">{active.domain}</span>
            )}
          </span>
          <Icons.caretUpDown size={13} className="shrink-0 text-ink-3" />
        </button>

        {open && (
          <div
            role="listbox"
            aria-label="Sites"
            className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-[9px] border border-line bg-bg shadow-lg"
          >
            <div className="max-h-[260px] overflow-y-auto scroll py-1">
              {workspaces.map((w) => {
                const isActive = w.id === active?.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => choose(w.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel-2 cursor-pointer",
                      isActive && "bg-panel",
                    )}
                  >
                    <Avatar initials={w.initials} color={w.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] text-ink">{w.name}</span>
                        <StatusDot status={w.status} />
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-ink-3">{w.domain}</span>
                    </span>
                    {isActive && <Icons.check size={13} className="shrink-0 text-accent-ink" />}
                  </button>
                );
              })}
            </div>
            <div className="border-t border-line-soft px-2.5 py-2">
              {/* The Add dialog lives on /workspaces; this points at it rather
                  than duplicating a form that starts a whole analysis pipeline. */}
              <Link
                href="/workspaces"
                onClick={() => setOpen(false)}
                aria-disabled={!canAdd}
                className={cn(
                  "flex items-center gap-1.5 text-[12.5px] font-medium",
                  canAdd
                    ? "text-accent-ink hover:underline decoration-line underline-offset-[3px]"
                    : "text-ink-4",
                )}
              >
                <Icons.plus size={13} />
                Add site
              </Link>
              <div className="mt-0.5 font-mono text-[10.5px] text-ink-3" data-testid="site-slots">
                {siteSlotsLabel(allowance)}
                {!canAdd && " · upgrade to add more"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

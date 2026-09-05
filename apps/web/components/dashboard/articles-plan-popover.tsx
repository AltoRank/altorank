"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Icons } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { PausedBanner } from "@/components/dashboard/paused-banner";
import { applyArticlesPlan, getArticlesPlanState, previewArticlesPlan, type ArticlesPlanState } from "@/app/actions/plan";
import { describePace } from "@/lib/plan/pace-options";

/** Monday first, as the calendar grid is; values are `Date#getUTCDay`. */
const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function paceButtonLabel(pace: number | null | undefined): string {
  if (pace === null || pace === undefined) return "Articles plan";
  if (pace === 0) return "Articles plan: off";
  return `Articles plan: ${describePace(pace)}`;
}

/**
 * The Articles-plan control: how many a week, on which days, and what that
 * does to the calendar - decided from the calendar rather than from a settings
 * tab two clicks away where the consequence is out of sight.
 *
 * Scope follows the sidebar switcher (`useWorkspace().active`); there is no
 * picker of its own. The button label reads from the context so it is right
 * on first paint; everything else is fetched when the popover opens, because
 * the quota and capacity behind it are three queries the calendar page does
 * not otherwise need.
 */
export function ArticlesPlanPopover() {
  const { active } = useWorkspace();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click and Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;

  return (
    <div className="relative" ref={wrapRef}>
      <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        <Icons.calendar size={13} />
        {paceButtonLabel(active.auto_generate_weekly_limit ?? null)}
        <Icons.caretDown size={12} className="text-ink-3" />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Articles plan"
          className="absolute right-0 top-[calc(100%+6px)] z-[80] w-[380px] rounded-[10px] border border-line bg-bg p-4 shadow-lg"
        >
          {/* Keyed on the site so switching while open starts clean rather
              than showing one site's plan under another's name. */}
          <PlanPanel key={active.id} workspaceId={active.id} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

type Selection = { pace: number; days: number[] };
const selectionKey = (s: Selection) => `${s.pace}|${s.days.join(",")}`;

function PlanPanel({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<ArticlesPlanState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  // The preview is remembered with the selection it describes, so a stale
  // sentence is never shown against a newer choice and no effect has to
  // clear it.
  const [preview, setPreview] = useState<{ key: string; sentence: string; planned: number } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getArticlesPlanState(workspaceId)
      .then((s) => {
        if (cancelled) return;
        setState(s);
        setSelection({ pace: s.pace, days: s.days });
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load the plan");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const current = state ? selectionKey({ pace: state.pace, days: state.days }) : null;
  const chosen = selection ? selectionKey(selection) : null;
  const dirty = state !== null && selection !== null && chosen !== current;

  // Say what the change does before it is confirmed. Debounced: each toggle
  // is a recommendation query on the server.
  useEffect(() => {
    if (!dirty || !selection || !chosen) return;
    let cancelled = false;
    const t = setTimeout(() => {
      previewArticlesPlan(workspaceId, selection.pace, selection.days)
        .then((p) => {
          if (!cancelled) setPreview({ key: chosen, sentence: p.sentence, planned: p.planned });
        })
        .catch(() => {
          /* the Apply button still works; the sentence is a courtesy */
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `selection` is captured through `chosen`, its string form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dirty, chosen]);

  if (loadError) return <p className="text-[12.5px] text-[var(--err)]">{loadError}</p>;
  if (!state || !selection) return <p className="text-[12.5px] text-ink-3">Loading…</p>;

  const { pace, days } = selection;
  const shownPreview = dirty && preview?.key === chosen ? preview : null;
  const previewing = dirty && !shownPreview;

  function setPace(p: number) {
    setSelection((s) => (s ? { ...s, pace: p } : s));
  }
  function toggleDay(day: number) {
    setSelection((s) =>
      s ? { ...s, days: s.days.includes(day) ? s.days.filter((d) => d !== day) : [...s.days, day].sort((a, b) => a - b) } : s,
    );
  }

  function apply() {
    start(async () => {
      try {
        const r = await applyArticlesPlan(workspaceId, pace, days);
        const paceWords = describePace(r.pace);
        toast.success(
          r.pace === 0
            ? "Writing paused for this site. Nothing already written changes."
            : `${paceWords[0].toUpperCase()}${paceWords.slice(1)}${
                r.days.length ? `, publishing on ${r.days.length} ${r.days.length === 1 ? "day" : "days"}` : ""
              }. ${r.planned} planned.`,
        );
        onDone();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not change the plan");
      }
    });
  }

  return (
    <div className="space-y-4 text-[13px]">
      {state.status === "paused" && <PausedBanner workspaceId={state.workspaceId} meta={state.pausedMeta} />}

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Current plan</span>
          <span className="text-[12px] text-ink-3">
            {state.pace === 0 ? "off" : describePace(state.pace)} · {state.capacity.scheduled} of {state.capacity.cap} planned
          </span>
        </div>
        <ul className="divide-y divide-line-soft rounded-[8px] border border-line">
          {state.options.map((o) => {
            const selected = o.pace === pace;
            return (
              <li key={o.pace}>
                {o.allowed ? (
                  <button
                    type="button"
                    onClick={() => setPace(o.pace)}
                    aria-pressed={selected}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors cursor-pointer hover:bg-panel-2 ${
                      selected ? "bg-panel font-medium text-ink" : "text-ink-2"
                    }`}
                  >
                    <span>{o.label}</span>
                    <span className="text-[12px] text-ink-3">{o.meaning}</span>
                  </button>
                ) : (
                  <div className="flex w-full items-center justify-between gap-3 px-3 py-2 text-ink-3">
                    <span>
                      {o.label}
                      <span className="ml-2 text-[11.5px]">{o.meaning}</span>
                    </span>
                    <Link
                      href="/settings/billing"
                      className="shrink-0 text-[11.5px] text-accent-ink underline decoration-line underline-offset-[3px]"
                    >
                      Needs the {o.needsPlanLabel} plan
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {pace > 7 && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
            The calendar plans one a day at most; the rest comes from the live keyword queue as the generator
            runs.
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Publish on</div>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((w) => (
            <Chip key={w.day} label={w.label} active={days.includes(w.day)} onClick={() => toggleDay(w.day)} />
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          Articles are generated in the morning UTC and wait in review; publishing happens on the days you
          choose.{" "}
          {days.length === 0 && "No days chosen: approved articles are not published on a schedule."}
        </p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">{state.schedule}</p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="min-h-[1.25rem] text-[12px] text-ink-3">
          {dirty
            ? shownPreview?.sentence ?? "Working out what changes…"
            : `${state.capacity.available} free of ${state.capacity.cap}.`}
        </span>
        <Button size="sm" variant="primary" onClick={apply} disabled={!dirty || pending || previewing}>
          {pending ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}

"use client";

// ---------------------------------------------------------------------------
// The month grid, with drag-and-drop between days
// ---------------------------------------------------------------------------
//
// The page builds the cells on the server; this lays them out and lets a
// planned keyword be dragged onto another day. A drop calls the same
// `reschedulePlannedEntry` the card's Move dialog calls - one way to move an
// entry, two ways to ask for it - and shows the move at once, reverting with
// the server's words if it is refused.
//
// Only a planned keyword with no article moves; a card that is being written
// or already written keeps its handle greyed and says why on hover. Keyboard:
// focus the handle, Space to lift, arrows to step between days, Space to drop,
// Escape to cancel. The date-picker Move stays as the fallback for everyone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import type { CalendarEntry } from "@/lib/types";
import type { PlannerKeyword } from "@/lib/queries/keywords";
import type { ArticleFacts } from "@/lib/plan/card-state";
import { plannerCardState, dragBlockReason } from "@/lib/plan/card-state";
import { splitVisible, type DayCell } from "@/lib/plan/day-groups";
import { reschedulePlannedEntry } from "@/app/actions/plan";
import { plural } from "@/lib/utils";
import { PlannerCard, type WriteGate } from "./planner-card";

export type PlannerItem = {
  entry: CalendarEntry;
  keyword: PlannerKeyword | null;
  workspace: { initials: string; color: string; domain: string | null } | null;
  article: ArticleFacts;
  /** A draft for this keyword being written now, before the entry links to it. */
  inFlight: { createdAt: string; phase: "research" | "drafting" } | null;
};

export type PlannerCell = DayCell<PlannerItem> | null;

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Arrow keys step to the neighbouring day rather than nudging by pixels: the
 * next cell in that direction, on the same row for left/right and the same
 * column for up/down.
 */
const stepBetweenDays: KeyboardCoordinateGetter = (event, { context: { active, collisionRect, droppableRects, droppableContainers } }) => {
  if (!active || !collisionRect) return;
  const dir: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
  const d = dir[event.code];
  if (!d) return;
  event.preventDefault();

  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  let best: { left: number; top: number; width: number; height: number } | undefined;
  let bestDist = Infinity;
  for (const container of droppableContainers.getEnabled()) {
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const dx = rect.left + rect.width / 2 - cx;
    const dy = rect.top + rect.height / 2 - cy;
    if (d[0] !== 0 && (Math.sign(dx) !== d[0] || Math.abs(dy) > rect.height / 2)) continue;
    if (d[1] !== 0 && (Math.sign(dy) !== d[1] || Math.abs(dx) > rect.width / 2)) continue;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = rect; }
  }
  if (!best) return;
  return {
    x: best.left + Math.max(0, (best.width - collisionRect.width) / 2),
    y: best.top + Math.max(0, (best.height - collisionRect.height) / 2),
  };
};

/** Drop where the pointer is; with no pointer (keyboard), the nearest day. */
const dayUnderPointer: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : closestCenter(args);
};

export function PlannerGrid({ cells: serverCells, now, writeGate }: { cells: PlannerCell[]; now: number; writeGate: WriteGate }) {
  const router = useRouter();
  const [cells, setCells] = useState(serverCells);
  const [activeId, setActiveId] = useState<string | null>(null);
  const pendingMove = useRef(false);

  // The server re-renders after every refresh; take its word unless a move is
  // still in flight, when the optimistic layout is the truer one.
  useEffect(() => {
    if (!pendingMove.current) setCells(serverCells);
  }, [serverCells]);

  const sensors = useSensors(
    // A few pixels of travel before a drag begins, so the card's buttons still click.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: stepBetweenDays }),
  );

  const itemsById = useMemo(() => {
    const m = new Map<string, PlannerItem>();
    for (const c of cells) for (const it of c?.items ?? []) m.set(it.entry.id, it);
    return m;
  }, [cells]);
  const active = activeId ? itemsById.get(activeId) ?? null : null;

  const onDragStart = useCallback((e: DragStartEvent) => setActiveId(String(e.active.id)), []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      const entryId = String(e.active.id);
      const to = e.over ? String(e.over.id) : null;
      const item = itemsById.get(entryId);
      if (!item || !to) return;
      const from = item.entry.scheduled_date.slice(0, 10);
      if (to === from) return;

      const before = cells;
      setCells((prev) =>
        prev.map((c) => {
          if (!c) return c;
          if (c.date === from) return { ...c, items: c.items.filter((i) => i.entry.id !== entryId) };
          if (c.date === to) return { ...c, items: [...c.items, { ...item, entry: { ...item.entry, scheduled_date: to } }] };
          return c;
        }),
      );
      pendingMove.current = true;
      reschedulePlannedEntry(entryId, to)
        .then(() => { pendingMove.current = false; router.refresh(); })
        .catch((err: unknown) => {
          pendingMove.current = false;
          setCells(before);
          toast.error(err instanceof Error ? err.message : "Could not move this entry.");
        });
    },
    [cells, itemsById, router],
  );

  const announcements = {
    onDragStart: ({ active }: { active: { id: string | number } }) =>
      `Picked up ${itemsById.get(String(active.id))?.entry.keyword ?? "entry"}. Use the arrow keys to choose a day.`,
    onDragOver: ({ over }: { over: { id: string | number } | null }) => (over ? `Over ${longDate(String(over.id))}.` : "Not over a day."),
    onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
      over
        ? `Moved ${itemsById.get(String(active.id))?.entry.keyword ?? "entry"} to ${longDate(String(over.id))}.`
        : "Move cancelled.",
    onDragCancel: () => "Move cancelled.",
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={dayUnderPointer}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{ announcements, screenReaderInstructions: { draggable: "Press Space to lift a planned keyword, arrow keys to choose a day, Space to drop, Escape to cancel." } }}
    >
      <div className="grid grid-cols-7 bg-panel border-b border-line">
        {DAY_NAMES.map((d) => (
          <div key={d} className="px-3.5 py-2.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3 border-r border-line last:border-r-0">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell, i) =>
          cell ? (
            <DayCellView key={cell.date} cell={cell} now={now} writeGate={writeGate} dragging={activeId !== null} />
          ) : (
            <div key={`pad-${i}`} className="min-h-[130px] border-r border-line-soft border-b border-b-line-soft [&:nth-child(7n)]:border-r-0 bg-[oklch(0.99_0_0)]" />
          ),
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? (
          <div className="max-w-[180px] rounded-[7px] border border-line bg-bg px-2 py-1.5 text-xs text-ink shadow-md leading-[1.35]">
            {active.entry.keyword}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DayCellView({ cell, now, writeGate, dragging }: { cell: DayCell<PlannerItem>; now: number; writeGate: WriteGate; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: cell.date });
  const { shown, hidden } = splitVisible(cell.items);
  const running = cell.items.some((it) => plannerCardState(it.entry, it.article, it.inFlight !== null) === "writing");

  return (
    <div
      ref={setNodeRef}
      className={`group/day min-h-[130px] p-2 px-2.5 border-r border-line-soft border-b border-b-line-soft [&:nth-child(7n)]:border-r-0 transition-colors ${
        isOver ? "bg-accent-soft/70 ring-1 ring-inset ring-accent" : running ? "bg-accent-soft" : ""
      }`}
    >
      <div className={`mb-1.5 flex items-baseline justify-between font-mono text-[11px] ${running ? "text-accent-ink font-semibold" : "text-ink-3"}`}>
        <span>{cell.dayNum}</span>
        {cell.items.length > 1 && (
          <span className="text-[10px] text-ink-3" title={plural(cell.items.length, "article")}>
            {cell.items.length}
          </span>
        )}
      </div>
      <div className="space-y-2.5">
        {shown.map((item) => (
          <DraggableCard key={item.entry.id} item={item} now={now} writeGate={writeGate} />
        ))}
        {hidden > 0 && <div className="font-mono text-[10px] text-ink-3">+{hidden} more</div>}
        {cell.items.length === 0 && (
          // TODO: point "research keywords" at the research drawer once it lands (#72); /keywords for now.
          <p
            className={`m-0 pt-3 text-[11px] leading-snug text-ink-3 transition-opacity ${
              dragging ? "opacity-100" : "opacity-0 group-hover/day:opacity-100 group-focus-within/day:opacity-100"
            }`}
          >
            Drag a keyword here, or{" "}
            <Link href="/keywords" className="underline decoration-line underline-offset-[3px] hover:text-ink">
              research keywords
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

function DraggableCard({ item, now, writeGate }: { item: PlannerItem; now: number; writeGate: WriteGate }) {
  const state = plannerCardState(item.entry, item.article, item.inFlight !== null);
  const blocked = dragBlockReason(state);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: item.entry.id,
    disabled: blocked !== null,
    data: { date: item.entry.scheduled_date.slice(0, 10), term: item.entry.keyword },
  });

  return (
    <div ref={setNodeRef} className={isDragging ? "opacity-40" : undefined}>
      <PlannerCard
        entry={item.entry}
        keyword={item.keyword}
        workspace={item.workspace}
        article={item.article}
        inFlight={item.inFlight}
        now={now}
        writeGate={writeGate}
        drag={{ blocked, handleRef: setActivatorNodeRef, handleProps: { ...listeners, ...attributes } }}
      />
    </div>
  );
}

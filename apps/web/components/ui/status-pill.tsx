import { cn } from "@/lib/utils";
import { STATUS_META } from "@/lib/constants";

type StatusPillProps = {
  status: string;
  label?: string;
  className?: string;
};

export function StatusPill({ status, label, className }: StatusPillProps) {
  const meta = STATUS_META[status] ?? { label: status, cls: "s-draft" };
  const displayLabel = label ?? meta.label;

  const colorMap: Record<string, string> = {
    "s-ok": "bg-ok-soft text-ok-ink",
    "s-warn": "bg-warn-soft text-warn-ink",
    "s-err": "bg-err-soft text-err-ink",
    "s-run": "bg-accent-soft text-accent-ink",
    "s-draft": "bg-panel-2 text-ink-2",
    "s-idle": "bg-transparent text-ink-3 border border-line",
  };

  const dotColorMap: Record<string, string> = {
    "s-ok": "bg-ok",
    "s-warn": "bg-warn",
    "s-err": "bg-err",
    "s-run": "bg-accent animate-[pulse_1.4s_infinite]",
    "s-draft": "bg-ink-3",
    "s-idle": "bg-ink-3",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] px-[7px] py-px rounded-full text-[11px] font-medium whitespace-nowrap",
        colorMap[meta.cls] ?? "bg-panel-2 text-ink-2",
        className
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", dotColorMap[meta.cls] ?? "bg-ink-3")} />
      {displayLabel}
    </span>
  );
}

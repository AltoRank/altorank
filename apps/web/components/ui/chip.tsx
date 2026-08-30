"use client";

import { cn } from "@/lib/utils";

type ChipProps = {
  label: string;
  active?: boolean;
  soft?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
};

export function Chip({ label, active, soft, disabled, onClick, className }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-[9px] py-[3px] rounded-full text-xs text-ink-2 bg-transparent border border-transparent whitespace-nowrap cursor-pointer transition-colors",
        "hover:bg-panel-2",
        active && "bg-ink text-bg hover:bg-ink",
        soft && !active && "bg-panel-2",
        disabled && "opacity-40 pointer-events-none",
        className
      )}
    >
      {label}
    </button>
  );
}

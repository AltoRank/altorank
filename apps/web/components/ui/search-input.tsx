"use client";

import { Icons } from "./icons";
import { cn } from "@/lib/utils";

type SearchInputProps = {
  placeholder?: string;
  shortcut?: string;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
};

export function SearchInput({ placeholder, shortcut, value, onChange, className }: SearchInputProps) {
  return (
    <div className={cn(
      "flex items-center gap-2 px-2.5 py-1.5 bg-panel-2 border border-transparent rounded-[7px] min-w-0",
      "focus-within:border-line focus-within:bg-bg",
      className
    )}>
      <Icons.search size={14} className="text-ink-3 shrink-0" />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="flex-1 border-0 outline-0 bg-transparent text-[13px] min-w-0"
      />
      {shortcut && (
        <kbd className="font-mono text-[10.5px] px-[5px] py-px rounded bg-bg text-ink-3 border border-line">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}

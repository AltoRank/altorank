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
    // min-w-[200px], not min-w-0. Every filter row that holds one of these
    // is `flex flex-wrap` with the box as `flex-1 max-w-[320px]` beside four
    // or five chips, and at phone width the chips would not shrink, so the
    // box was squeezed down to its magnifier icon: Keywords, Articles,
    // Backlinks and Workspaces each shipped a search field with no room to
    // type in it. A floor makes the chips wrap under it instead. The inner
    // <input> keeps min-w-0 so long text still truncates.
    <div className={cn(
      "flex items-center gap-2 px-2.5 py-1.5 bg-panel-2 border border-transparent rounded-[7px] min-w-[200px]",
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

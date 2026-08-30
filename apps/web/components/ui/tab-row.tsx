"use client";

import { cn } from "@/lib/utils";

type Tab = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
};

type TabRowProps = {
  tabs: Tab[];
  activeTab: string;
  onChange?: (id: string) => void;
  actions?: React.ReactNode;
  className?: string;
};

export function TabRow({ tabs, activeTab, onChange, actions, className }: TabRowProps) {
  return (
    <div className={cn("px-8 flex gap-0 items-center border-b border-line bg-bg", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange?.(tab.id)}
          className={cn(
            "px-3.5 py-3 text-[13.5px] text-ink-3 border-b-2 border-transparent -mb-px flex items-center gap-[7px] cursor-pointer transition-colors",
            "hover:text-ink",
            activeTab === tab.id && "text-ink border-b-ink font-medium"
          )}
        >
          {tab.icon}
          <span>{tab.label}</span>
          {tab.count != null && (
            <span className="px-1.5 font-mono text-[10.5px] font-medium bg-panel-2 text-ink-2 rounded-full">
              {tab.count}
            </span>
          )}
        </button>
      ))}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

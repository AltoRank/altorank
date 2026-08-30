import { cn } from "@/lib/utils";

type PageHeadProps = {
  title: string;
  subtitle?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

export function PageHead({ title, subtitle, eyebrow, actions, className }: PageHeadProps) {
  return (
    <div
      className={cn(
        "px-8 pt-6 pb-[18px] border-b border-line",
        actions && "flex items-end gap-5",
        className
      )}
    >
      <div className={cn(actions && "flex-1 min-w-0")}>
        {eyebrow && (
          <div className="flex items-center gap-2.5 text-xs text-ink-3 mb-2.5 flex-wrap">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-[-0.018em] m-0 mb-1.5">{title}</h1>
        {subtitle && (
          <div className="text-[13.5px] text-ink-3 flex items-center gap-3.5 flex-wrap">
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex gap-2 flex-wrap ml-auto">{actions}</div>
      )}
    </div>
  );
}

export function DotSep() {
  return <span className="w-[3px] h-[3px] rounded-full bg-ink-4" />;
}

export function EyebrowCode({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono px-[7px] py-0.5 bg-panel-2 rounded text-ink-2">
      {children}
    </span>
  );
}

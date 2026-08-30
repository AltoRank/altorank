import { cn } from "@/lib/utils";

export function Card({
  title,
  meta,
  className,
  children,
}: {
  title?: string;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("bg-bg border border-line rounded-lg overflow-hidden", className)}>
      {title && (
        <div className="px-[18px] py-3.5 border-b border-line-soft flex items-center gap-2.5">
          <h3 className="m-0 text-sm font-semibold tracking-[-0.005em]">{title}</h3>
          {meta && <div className="ml-auto text-ink-3 text-xs">{meta}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

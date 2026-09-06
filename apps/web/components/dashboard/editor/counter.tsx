import { cn } from "@/lib/utils";
import { fieldCounter } from "@/lib/editor/proposals";

/**
 * `N/60` for a title, `N/160` for a meta description. A count against what a
 * result page displays, red once past it. Its own file so it can be rendered
 * in a test without pulling the server actions the fields call.
 */
export function Counter({
  text,
  field,
  className,
}: {
  text: string;
  field: "title" | "meta_description";
  className?: string;
}) {
  const c = fieldCounter(text, field);
  return (
    <span
      className={cn("font-mono text-[11px] tabular-nums", c.over ? "text-err-ink" : "text-ink-3", className)}
      aria-label={`${c.count} of ${c.limit} characters${c.over ? ", over the limit" : ""}`}
    >
      {c.count}/{c.limit}
    </span>
  );
}

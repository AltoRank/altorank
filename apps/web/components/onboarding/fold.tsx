import { Icons } from "@/components/ui";

/**
 * A section of the gate folded to one line of what is inside it: the setup
 * log, the calendar, the site report. Shut by default - the article and the
 * ask lead the page - and a `<details>`, so the browser owns the toggle.
 */
export function Fold({ title, line, tone, children }: { title: string; line: string; tone?: "err"; children: React.ReactNode }) {
  return (
    <details className="group rounded-[10px] border border-line bg-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-3.5 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{title}</div>
          <p className={`m-0 mt-0.5 truncate text-[12px] group-open:whitespace-normal ${tone === "err" ? "text-err-ink" : "text-ink-2"}`}>{line}</p>
        </div>
        <span className="shrink-0 text-ink-3 transition-transform group-open:rotate-180">
          <Icons.caretDown size={12} />
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-5 py-4">{children}</div>
    </details>
  );
}

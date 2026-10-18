import Link from "next/link";
import { Button } from "@/components/ui";
import { plural } from "@/lib/utils";

/**
 * The one thing on the dashboard that waits on a person: the oldest draft in
 * review. It was said four times on this page (sidebar badge, a stat tile, a
 * recommended-action card and a "Needs your review" card) and none of them
 * was the page's primary button - that was "Add workspace" (UX clarity audit
 * 2026-10-18, #2). Now it is said once, at the top, with the only accent
 * button on the page.
 */
export function NextUp({ draft, waiting }: { draft: { id: string; title: string }; waiting: number }) {
  const others = waiting - 1;
  return (
    <section
      aria-label="Next up"
      className="mb-4 flex flex-col gap-4 rounded-[10px] border border-accent/30 bg-accent-soft/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-accent-ink">Next up</div>
        <h2 className="m-0 text-[17px] font-semibold leading-snug [text-wrap:balance]">
          <span className="text-ink">{draft.title}</span> <span className="font-normal text-ink-2">is ready for your yes</span>
        </h2>
        <p className="m-0 mt-1 text-[12.5px] text-ink-3">
          Nothing publishes until you approve it.
          {others > 0 && (
            <>
              {" "}
              <Link href="/articles?status=review" className="text-ink-2 underline underline-offset-2 hover:text-accent-ink">
                {plural(others, "more draft")} waiting
              </Link>
            </>
          )}
        </p>
      </div>
      <Link href={`/content/${draft.id}`} className="shrink-0">
        <Button variant="accent">Read and approve</Button>
      </Link>
    </section>
  );
}

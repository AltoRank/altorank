"use client";

// ---------------------------------------------------------------------------
// The first article, before the trial: its shape, with the text locked
// ---------------------------------------------------------------------------
//
// One card for both places the trial is asked for - the end of the setup run
// and every later visit to /onboarding - so the two cannot drift apart. It
// has no link: there is nowhere to read the article before the trial, and a
// link that led to a lock screen would be a promise the page then breaks.
// The props carry no text beyond the headings (lib/onboarding/first-article.ts
// builds them on the server), so there is nothing in the page to copy either.

import { Icons } from "@/components/ui";
import type { FirstArticleCard, FirstArticleVerdict } from "@/lib/onboarding/first-article";

const VERDICT: Record<FirstArticleVerdict, { text: string; className: string }> = {
  clean: { text: "Fact check passed", className: "text-ok" },
  review: { text: "Fact check: review", className: "text-warn" },
  high_risk: { text: "Fact check: needs work", className: "text-err" },
};

/** "Sep 7" from a YYYY-MM-DD, in UTC so the day the planner wrote is the day shown. */
function calendarDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What the run itself knows about the draft, for the moment before the card is read. */
export type PendingFirstArticle = {
  title: string;
  keyword: string;
  wordCount: number;
  verdict: FirstArticleVerdict;
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="m-0 truncate text-[12.5px] text-ink">{children}</dd>
    </div>
  );
}

export function FirstArticleCardView({
  article,
  pending = null,
}: {
  article: FirstArticleCard | null;
  /** Shown while the page has not yet read the card for a draft the run just wrote. */
  pending?: PendingFirstArticle | null;
}) {
  const title = article?.title || pending?.title || article?.keyword || pending?.keyword || "Untitled";
  const keyword = article?.keyword ?? pending?.keyword ?? "";
  const wordCount = article?.wordCount ?? pending?.wordCount ?? 0;
  const verdict = article ? article.verdict : pending?.verdict ?? null;
  if (!article && !pending) return null;

  return (
    <section aria-label="Your first article" className="rounded-[10px] border border-line bg-bg p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-ink-3">Your first article</span>
        {verdict && <span className={`shrink-0 text-[11.5px] ${VERDICT[verdict].className}`}>{VERDICT[verdict].text}</span>}
      </div>
      <h2 className="m-0 text-[16px] font-semibold leading-snug text-ink">{title}</h2>

      <dl className="m-0 mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Target keyword">{keyword || "—"}</Fact>
        <Fact label="Scheduled for">
          {article ? (article.scheduledDate ? calendarDay(article.scheduledDate) : "Not on the calendar yet") : "…"}
        </Fact>
        <Fact label="Length">{wordCount > 0 ? `${wordCount.toLocaleString("en-US")} words` : "—"}</Fact>
        {/* Counted from the article's own outbound links, so 0 is a
            measurement and printed as one. Unknown until the card is read. */}
        <Fact label="Sources cited">{article ? article.sources.toLocaleString("en-US") : "…"}</Fact>
      </dl>

      <div className="mt-4">
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-3">Outline</div>
        {article ? (
          article.outline.length > 0 ? (
            <ol className="m-0 list-decimal pl-5 text-[13px] leading-[1.6] text-ink-2">
              {article.outline.map((heading, i) => (
                <li key={`${i}-${heading}`}>{heading}</li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-[12.5px] text-ink-3">This article has no section headings.</p>
          )
        ) : (
          <p className="m-0 text-[12.5px] text-ink-3">Reading the outline…</p>
        )}
      </div>

      <p className="m-0 mt-4 flex items-center gap-1.5 text-[12.5px] text-ink-2">
        <Icons.lock size={12} />
        The full text opens when your trial starts.
      </p>
      {article && article.more > 0 && (
        <p className="m-0 mt-1.5 text-[12px] text-ink-3">
          {article.more} more {article.more === 1 ? "draft is" : "drafts are"} written for this site and open with the trial too.
        </p>
      )}
    </section>
  );
}

import { Icons } from "@/components/ui";
import type { OnboardingPlanned } from "@/lib/onboarding/events";

/**
 * Why the plan chose its topics, folded. Under the first article (`only`) it
 * is the reason for that one article, headed by its search: the brief's angle
 * used to head it, read as a second title one screen below the card's, and a
 * first-timer took it for a second article (review, 2026-10-12).
 *
 * No verdict labels: this sits on the paywall, before the trial, and "Early
 * reader … not yet shopping", "Lower confidence" and "Unmeasured" argued
 * against buying (UX audit 2026-10-12, #8). Who the article is for is said
 * as what it brings: the reader and what they are working on.
 */
export function TopicBriefs({ planned, title, only }: { planned: OnboardingPlanned[]; title?: string; only?: string }) {
  const topics = planned
    .filter((p) => p.brief?.status === "qualified" && (!only || p.term.trim().toLowerCase() === only.trim().toLowerCase()))
    .slice(0, 5);
  if (!topics.length) return null;
  return <section>
    <h2 className="mb-2 text-[15px] font-semibold">{title ?? (topics.length === 1 ? "Why this article" : "Why these articles")}</h2>
    <div className="flex flex-col gap-3">{topics.map(({ term, brief }) => {
      return <details key={term} className="group rounded-lg border border-line bg-panel">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-4 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block font-medium">{only ? <>Why we chose “{term}”</> : brief!.angle}</span>
          </span>
          <span className="mt-1 shrink-0 text-ink-3 transition-transform group-open:rotate-180"><Icons.caretDown size={12} /></span>
        </summary>
        <dl className="m-0 grid gap-2 border-t border-line p-4 text-sm text-ink-2">
          {only && <div><dt className="font-medium">The angle</dt><dd className="m-0">{brief!.angle}</dd></div>}
          <div><dt className="font-medium">Who it brings to your site</dt><dd className="m-0">{brief!.audience} · {brief!.buyingJob}</dd></div>
          <div><dt className="font-medium">Your offering</dt><dd className="m-0">{brief!.offering}</dd></div>
          {!only && <div><dt className="font-medium">Search</dt><dd className="m-0">{term}</dd></div>}
          <div><dt className="font-medium">Why it fits</dt><dd className="m-0">{brief!.reason}</dd></div>
          <div><dt className="font-medium">Search evidence</dt><dd className="m-0">{brief!.evidenceUrls?.map((url) => <a key={url} className="mr-3 inline-block text-accent underline" href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a>)}</dd></div>
        </dl>
      </details>;
    })}</div>
  </section>;
}

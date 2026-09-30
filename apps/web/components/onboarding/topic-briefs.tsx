import type { OnboardingPlanned } from "@/lib/onboarding/events";
import { topicLabels } from "@/lib/keyword-research/topic-labels";

export function TopicBriefs({ planned }: { planned: OnboardingPlanned[] }) {
  const topics = planned.filter((p) => p.brief?.status === "qualified").slice(0, 5);
  if (!topics.length) return null;
  return <section className="my-5">
    <h2 className="mb-3 text-lg font-semibold">Why these articles</h2>
    <div className="flex flex-col gap-3">{topics.map(({term,brief}) => <details key={term} className="rounded-lg border border-line bg-panel p-4">
      <summary className="cursor-pointer font-medium">{brief!.angle}{topicLabels(brief).map((l) => <span key={l.label} title={l.explain} className={`ml-2 rounded-full border border-line px-2 py-0.5 text-[11px] font-normal ${l.label === "Top of funnel" ? "text-ink-3" : "text-warn"}`}>{l.label}</span>)}</summary>
      <dl className="mt-3 grid gap-2 text-sm text-ink-2">
        <div><dt className="font-medium">{brief!.funnel === "audience" ? "Reader and what they are working on" : "Reader and buying problem"}</dt><dd>{brief!.audience} · {brief!.buyingJob}</dd></div>
        <div><dt className="font-medium">Your offering</dt><dd>{brief!.offering}</dd></div>
        <div><dt className="font-medium">Search</dt><dd>{term}</dd></div>
        <div><dt className="font-medium">Why it fits</dt><dd>{brief!.reason}</dd></div>
        {topicLabels(brief).map((l) => <div key={l.label}><dt className="font-medium">{l.label}</dt><dd>{l.explain}</dd></div>)}
        <div><dt className="font-medium">Search evidence</dt><dd>{brief!.evidenceUrls?.map((url) => <a key={url} className="mr-3 inline-block text-accent underline" href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a>)}</dd></div>
      </dl>
    </details>)}</div>
  </section>;
}

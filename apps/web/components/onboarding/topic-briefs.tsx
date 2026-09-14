import type { OnboardingPlanned } from "@/lib/onboarding/events";

export function TopicBriefs({ planned, onChoose, disabled }: { planned: OnboardingPlanned[]; onChoose?: (topic: OnboardingPlanned) => void; disabled?: boolean }) {
  const topics = planned.filter((p) => p.brief?.status === "qualified").slice(0, 5);
  if (!topics.length) return null;
  return <section className="my-5">
    <h2 className="mb-3 text-lg font-semibold">Why these articles</h2>
    <div className="flex flex-col gap-3">{topics.map((topic, index) => { const {term,brief} = topic; return <details open={Boolean(onChoose) && index === 0} key={term} className="rounded-lg border border-line bg-panel p-4">
      <summary className="cursor-pointer font-medium">{brief!.angle}</summary>
      <dl className="mt-3 grid gap-2 text-sm text-ink-2">
        <div><dt className="font-medium">Reader and buying problem</dt><dd>{brief!.audience} · {brief!.buyingJob}</dd></div>
        <div><dt className="font-medium">Your offering</dt><dd>{brief!.offering}</dd></div>
        <div><dt className="font-medium">Search</dt><dd>{term}</dd></div>
        <div><dt className="font-medium">Why it fits</dt><dd>{brief!.reason}</dd></div>
        <div><dt className="font-medium">Search demand</dt><dd>{brief!.demand?.volume == null ? "Not measured — search results support the topic, but demand is uncertain." : `${brief!.demand.volume.toLocaleString()} searches per month in your selected market. An estimate, not a promise of traffic.`}</dd></div>
        <div><dt className="font-medium">Search evidence</dt><dd>{brief!.evidenceUrls?.map((url) => <a key={url} className="mr-3 inline-block text-accent underline" href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a>)}</dd></div>
      </dl>
      {onChoose && <button type="button" disabled={disabled || !topic.keywordId} onClick={() => onChoose(topic)} className="mt-4 rounded bg-accent px-4 py-2 text-white disabled:opacity-50">Write this article</button>}
    </details>; })}</div>
  </section>;
}

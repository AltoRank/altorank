import type { OnboardingPlanned } from "@/lib/onboarding/events";

export function TopicBriefs({ planned }: { planned: OnboardingPlanned[] }) {
  const topics = planned.filter((p) => p.brief?.status === "qualified").slice(0, 5);
  if (!topics.length) return null;
  return <section className="my-5">
    <h2 className="mb-3 text-lg font-semibold">Why these articles</h2>
    <div className="flex flex-col gap-3">{topics.map(({term,brief}) => <details key={term} className="rounded-lg border border-line bg-panel p-4">
      <summary className="cursor-pointer font-medium">{brief!.angle}</summary>
      <dl className="mt-3 grid gap-2 text-sm text-ink-2">
        <div><dt className="font-medium">Reader and buying problem</dt><dd>{brief!.audience} · {brief!.buyingJob}</dd></div>
        <div><dt className="font-medium">Your offering</dt><dd>{brief!.offering}</dd></div>
        <div><dt className="font-medium">Search</dt><dd>{term}</dd></div>
        <div><dt className="font-medium">Why it fits</dt><dd>{brief!.reason}</dd></div>
        <div><dt className="font-medium">Search evidence</dt><dd>{brief!.evidenceUrls?.map((url) => <a key={url} className="mr-3 inline-block text-accent underline" href={url} target="_blank" rel="noopener noreferrer">{new URL(url).hostname}</a>)}</dd></div>
      </dl>
    </details>)}</div>
  </section>;
}

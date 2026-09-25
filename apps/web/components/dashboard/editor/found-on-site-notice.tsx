import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { LIVE_ON_YOUR_SITE, type FoundOnSiteView } from "@/lib/found-on-site/state";

/**
 * The Publish panel for an article the nightly check found live on the
 * customer's own site (lib/found-on-site). Replaces the connect prompts and
 * the approve button, which would both be wrong about an article that is
 * already on the web: it says where it was found, what the match rests on,
 * that it now counts as published, and offers the one correction a person
 * can make - "that is not my article" - which puts it back as it was.
 *
 * Presentational: the editor owns the action and the pending state.
 */
export function FoundOnSiteNotice({
  view,
  onUndo,
  pending = false,
  error = null,
}: {
  view: FoundOnSiteView;
  onUndo: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  const found = new Date(view.foundAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="flex flex-col gap-2 rounded-[7px] border border-line bg-bg p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">Found on your site</span>
        <StatusPill status="live" label={LIVE_ON_YOUR_SITE} />
      </div>
      <a
        href={view.url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-[12px] text-accent-ink hover:underline"
      >
        {view.url}
      </a>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Our nightly check of your sitemap found this draft published there on {found}. {view.basis}. It went
        live without going through AltoRank, and counts as published.
      </p>
      <Button size="sm" variant="ghost" className="justify-center" disabled={pending} onClick={onUndo}>
        {pending ? "Putting it back…" : "Not my article"}
      </Button>
      {error && <div className="text-[11.5px] text-[var(--err)]">{error}</div>}
    </div>
  );
}

/**
 * The Publish panel's line for a site the nightly check cannot see (no
 * sitemap, robots.txt, JavaScript pages): a copy published there by hand will
 * not be noticed, and the person is told how to make it count.
 */
export function FoundOnSiteBlindNote({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-[7px] border border-line bg-bg p-2.5 text-[12px] leading-relaxed text-ink-3" role="note">
      {text}
    </p>
  );
}

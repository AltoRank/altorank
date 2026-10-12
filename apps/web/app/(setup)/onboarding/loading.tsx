/**
 * The first frame of /onboarding while the page reads what it needs. It is
 * shown to everyone who opens the page - a new signup, a reload mid-run, an
 * owner coming back to their first article days later - so it claims
 * nothing: it used to say "Reading your site… About a minute" to all of
 * them, and flashed that over a finished article (UX audit 2026-10-12).
 */
export default function OnboardingLoading() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6" role="status" aria-busy="true" aria-label="Opening your setup">
      <div className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink-2">
        <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" aria-hidden />
        Opening your setup…
      </div>
    </div>
  );
}

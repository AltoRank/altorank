/**
 * The same screen the wizard opens on (`ReadingSite` in
 * components/onboarding/wizard.tsx), without the domain it does not know yet.
 * Between the confirmation link and the wizard the page awaits four reads and
 * used to show nothing at all; now the first frame and the second are the
 * same frame.
 */
export default function OnboardingLoading() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6" role="status" aria-busy="true" aria-label="Setting up your site">
      <div className="w-full max-w-[560px] text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink-2">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Reading your site…
        </div>
        <h1 className="mb-2 text-[22px] font-semibold">Setting up your site</h1>
        <p className="mx-auto max-w-[420px] text-[13.5px] leading-[1.6] text-ink-2">
          We read your homepage, and your blog if the homepage is thin, to fill in what we can. The next few
          screens are a check rather than a form. About a minute.
        </p>
      </div>
    </div>
  );
}

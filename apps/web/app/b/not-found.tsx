/** /b/<slug> with no blog behind it, or one switched off. No hint of which. */
export default function HostedBlogNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-2 px-5">
      <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">404</p>
      <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Nothing is published here</h1>
      <p className="m-0 text-[14px] text-ink-2">The page may have moved, or this blog is not public yet.</p>
    </main>
  );
}

"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-xl bg-err/10 text-err">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="24" height="24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-ink-2">{error.message || "An unexpected error occurred."}</p>
        <button
          onClick={reset}
          className="rounded-lg border border-line bg-bg px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-panel"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

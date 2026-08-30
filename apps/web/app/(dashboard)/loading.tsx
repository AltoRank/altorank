export default function DashboardLoading() {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
        <span className="font-mono text-xs text-ink-3">Loading&hellip;</span>
      </div>
    </div>
  );
}

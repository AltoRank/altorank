import { PageBodySkeleton, PageHeadSkeleton, Skeleton, SkeletonSoft } from "@/components/ui/skeleton";

/**
 * The fallback for any dashboard route without its own `loading.tsx` - which
 * is now only `/review` (a bare `redirect`) and `/admin/users`. This used to
 * claim it also covered readiness, admin and "the settings sub-tabs that
 * render outside SettingsShell": readiness and admin have their own files
 * since, and no settings sub-tab ever rendered outside the shell -
 * `settings/loading.tsx` intercepts every one of them.
 *
 * It replaced a centred spinner over "Loading…", which was
 * the one thing on this branch that looked like a different page: the head
 * row, the sidebar and the body column stay where they are, and the page
 * that arrives fills the shape rather than replacing it.
 *
 * Nothing here is known - not the title, not the columns - so it is the one
 * skeleton made entirely of bars. Routes that know their shape get their own
 * file next to their page.
 */
export default function DashboardGroupLoading() {
  return (
    <>
      <PageHeadSkeleton titleWidth="w-40" actions={1} />
      <PageBodySkeleton label="Loading">
        <div className="bg-bg border border-line rounded-lg overflow-hidden">
          <div className="flex gap-6 px-3.5 py-2.5 border-b border-line bg-panel">
            {["w-24", "w-16", "w-20", "w-12"].map((w) => (
              <SkeletonSoft key={w} className={`h-2.5 ${w}`} />
            ))}
          </div>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex items-center gap-6 px-3.5 py-3 border-b border-line-soft">
              <Skeleton className={`h-3 ${i % 3 === 0 ? "w-56" : i % 3 === 1 ? "w-44" : "w-64"}`} />
              <SkeletonSoft className="h-3 w-20" />
              <SkeletonSoft className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-10" />
            </div>
          ))}
        </div>
      </PageBodySkeleton>
    </>
  );
}

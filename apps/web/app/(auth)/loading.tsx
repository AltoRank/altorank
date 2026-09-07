import { Skeleton, SkeletonSoft } from "@/components/ui/skeleton";

/**
 * The shape every auth page takes: a centred heading and one line under it,
 * then a short stack of fields and a full-width button.
 *
 * This was the centred spinner `components/ui/skeleton.tsx` opens by
 * describing as the thing to replace - the one boundary in the app that still
 * looked like a different page rather than the page arriving. Nothing here is
 * known (the heading is "Welcome back" on sign-in, something else on every
 * other route in the group), so it is all bars.
 */
export default function AuthLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading">
      <span className="sr-only">Loading</span>
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-7 w-48" />
        <SkeletonSoft className="h-3 w-36" />
      </div>
      <div className="space-y-4" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="space-y-1.5">
            <SkeletonSoft className="h-2.5 w-20" />
            <Skeleton className="h-[38px] w-full rounded-md" />
          </div>
        ))}
        <Skeleton className="h-[38px] w-full rounded-md" />
      </div>
      <SkeletonSoft className="mx-auto h-2.5 w-52" />
    </div>
  );
}

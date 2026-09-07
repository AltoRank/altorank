import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardSkeleton, PageBodySkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Without this the `(dashboard)` group fallback covered the route, and that
 * one draws a head row and a seven-row table. This page has no table at all:
 * it is one card with a domain field and a button
 * (`components/dashboard/readiness-check.tsx`). Title and subtitle are
 * constants on the page, so they are text.
 */
export default function ReadinessLoading() {
  return (
    <>
      <PageHead
        title="Agent readiness"
        subtitle="Whether an AI assistant can read a site, and the fixes if it cannot. Any domain, no workspace needed."
        actions={<ActionSkeleton width="w-28" />}
      />
      <PageBodySkeleton label="Loading the readiness check">
        <CardSkeleton title="Check a domain">
          <div className="flex gap-2">
            <Skeleton className="h-[38px] flex-1 rounded-md" />
            <Skeleton className="h-[38px] w-28 rounded-md" />
          </div>
        </CardSkeleton>
      </PageBodySkeleton>
    </>
  );
}

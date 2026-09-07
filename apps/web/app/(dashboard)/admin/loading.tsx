import { PageHead } from "@/components/ui";
import { CardSkeleton, PageBodySkeleton, StatStripSkeleton, SubtitleSkeleton } from "@/components/ui/skeleton";
import { AdminTabs } from "./admin-tabs";

/**
 * Without this the `(dashboard)` group fallback covered both admin routes, and
 * that one draws a head row and one four-column table - no stat strip, no
 * tabs, and nothing like the six stacked cards this page actually is
 * (`admin/page.tsx:161,185-242`).
 *
 * The tabs need only the pathname, so they are the real ones and the active
 * tab is right from the first frame - the same trick `settings/loading.tsx`
 * uses.
 */
export default function AdminLoading() {
  return (
    <>
      <PageHead title="Operations" subtitle={<SubtitleSkeleton width="w-64" />} />
      <AdminTabs />
      <StatStripSkeleton count={4} />
      <PageBodySkeleton label="Loading operations" className="flex flex-col gap-5">
        <CardSkeleton className="shrink-0" title="Preview as a customer" lines={2} />
        <CardSkeleton className="shrink-0" title="Scheduled work" lines={4} />
        <CardSkeleton className="shrink-0" title="Spend" lines={4} />
      </PageBodySkeleton>
    </>
  );
}

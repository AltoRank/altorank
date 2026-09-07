import { PageHead } from "@/components/ui";
import { CardSkeleton, PageBodySkeleton } from "@/components/ui/skeleton";

/**
 * This route had no boundary of its own, so `connect/loading.tsx` covered it -
 * and that one paints `title="Integrations"`, an sr-only "Loading
 * integrations" and three grids of integration tiles. The page is a list of
 * Search Console properties under "Choose your sites", which is a different
 * screen by every measure: wrong name, wrong count, wrong shape.
 *
 * Title, back link and subtitle are all constants on the page, so all three
 * are the real thing here.
 */
export default function ConnectGoogleLoading() {
  return (
    <>
      <PageHead
        title="Choose your sites"
        backHref="/connect"
        backLabel="Back to integrations"
        subtitle={<span>Search Console properties this Google account can see</span>}
      />
      <PageBodySkeleton label="Loading the properties this Google account can see">
        <CardSkeleton lines={4} />
      </PageBodySkeleton>
    </>
  );
}

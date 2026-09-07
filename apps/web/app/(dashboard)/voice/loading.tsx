import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardGridSkeleton, PageBodySkeleton } from "@/components/ui/skeleton";

/**
 * The page renders `title="Brand voice"` and a fixed subtitle, both known
 * before any data - so both are text here rather than bars.
 *
 * This said "Voice library", which is the name `voice/page.tsx` documents
 * killing: the heading said "Voice library", the tab said "Brand Voice" and
 * the nav said "Brand voice", three names for one page. The skeleton kept the
 * dead one, so the first frame still introduced the page by a name nothing
 * else uses and then swapped it.
 *
 * One card, not three: the page maps over the scoped workspace list, which is
 * one site unless the switcher says otherwise. Three placeholders for one card
 * is the count-claiming the primitives exist to avoid.
 */
export default function VoiceLoading() {
  return (
    <>
      <PageHead
        title="Brand voice"
        subtitle="Trained on sample text you approve. Articles for a workspace are written in its voice."
        actions={<ActionSkeleton width="w-32" />}
      />
      <PageBodySkeleton label="Loading the brand voice">
        <CardGridSkeleton count={1} cols="grid-cols-1 md:grid-cols-3" />
      </PageBodySkeleton>
    </>
  );
}

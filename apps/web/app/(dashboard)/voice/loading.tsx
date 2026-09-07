import { PageHead } from "@/components/ui";
import { ActionSkeleton, CardGridSkeleton, PageBodySkeleton, SubtitleSkeleton } from "@/components/ui/skeleton";

export default function VoiceLoading() {
  return (
    <>
      <PageHead title="Voice library" subtitle={<SubtitleSkeleton width="w-64" />} actions={<ActionSkeleton width="w-32" />} />
      <PageBodySkeleton label="Loading voices">
        <CardGridSkeleton count={3} cols="grid-cols-1 md:grid-cols-3" />
      </PageBodySkeleton>
    </>
  );
}

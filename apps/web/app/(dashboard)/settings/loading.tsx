import { PageHead } from "@/components/ui";
import { FormCardSkeleton, PageBodySkeleton, SubtitleSkeleton } from "@/components/ui/skeleton";
import { SettingsTabs } from "./settings-tabs";

/**
 * Every Settings tab renders through SettingsShell: head, tabs, a column of
 * form cards. The tabs need only the pathname, so they are the real ones and
 * the active tab is right from the first frame; the cards are placeholders.
 */
export default function SettingsLoading() {
  return (
    <>
      <PageHead title="Settings" subtitle={<SubtitleSkeleton width="w-72" />} />
      <SettingsTabs />
      <PageBodySkeleton label="Loading settings">
        <div className="max-w-[1140px] space-y-5">
          <FormCardSkeleton fields={4} />
          <FormCardSkeleton fields={2} />
        </div>
      </PageBodySkeleton>
    </>
  );
}

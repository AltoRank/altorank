import { FormCardSkeleton, PageBodySkeleton } from "@/components/ui/skeleton";
import { SettingsTabs } from "./settings-tabs";
import { SettingsLoadingHead } from "./loading-head";

/**
 * Every Settings tab renders through SettingsShell: head, tabs, a column of
 * form cards. The tabs need only the pathname, so they are the real ones and
 * the active tab is right from the first frame; the head now derives its title
 * the same way, because this file is the boundary for all eleven Settings
 * routes and calling every one of them "Settings" made nine of them introduce
 * themselves by the wrong name.
 *
 * Four cards, not two: `/settings` itself renders BusinessForm, SettingsForm,
 * AttributionCard and a Password card.
 */
export default function SettingsLoading() {
  return (
    <>
      <SettingsLoadingHead />
      <SettingsTabs />
      <PageBodySkeleton label="Loading settings">
        <div className="max-w-[1140px] space-y-5">
          <FormCardSkeleton fields={4} />
          <FormCardSkeleton fields={3} />
          <FormCardSkeleton fields={2} />
          <FormCardSkeleton fields={2} />
        </div>
      </PageBodySkeleton>
    </>
  );
}

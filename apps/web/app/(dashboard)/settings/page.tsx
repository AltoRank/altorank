import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { getAgency } from "@/lib/queries/agency";
import { SettingsForm } from "@/components/dashboard/settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const agency = await getAgency();

  if (!agency) {
    return <div className="p-8 text-ink-3">No agency found. Please sign in.</div>;
  }

  return (
    <>
      <PageHead
        title="Settings"
        eyebrow={<span>Agency settings</span>}
        subtitle={<span>Agency-wide defaults, white-label, and API access</span>}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <SettingsForm agency={agency} />
      </div>
    </>
  );
}

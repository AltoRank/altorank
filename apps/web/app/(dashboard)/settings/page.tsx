import type { Metadata } from "next";
import { PageHead, Card } from "@/components/ui";
import { getAgency } from "@/lib/queries/agency";
import { SettingsForm } from "@/components/dashboard/settings-form";
import { PasswordForm } from "@/components/dashboard/password-form";
import { SettingsTabs } from "./settings-tabs";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const agency = await getAgency();

  if (!agency) {
    return <div className="p-8 text-ink-3">No account found. Please sign in.</div>;
  }

  return (
    <>
      <PageHead
        title="Settings"
        subtitle={<span>Account-wide defaults, report branding, and API access</span>}
      />

      <SettingsTabs />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[1140px]">
          <SettingsForm agency={agency} />

          <div className="mt-5">
            <Card title="Password">
              <PasswordForm />
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

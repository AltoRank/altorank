import Link from "next/link";
import { PageHead, Card, Button } from "@/components/ui";
import { SettingsTabs } from "./settings-tabs";

/**
 * Head, tabs, and the scrolling column every Settings tab renders into. The
 * eight tabs used to repeat these twelve lines each.
 */
export function SettingsShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHead title={title} subtitle={subtitle} actions={actions} />
      <SettingsTabs />
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[1140px] space-y-5">{children}</div>
      </div>
    </>
  );
}

/** What a workspace-scoped tab shows when the account has no workspace yet. */
export function NoWorkspaceCard() {
  return (
    <Card>
      <div className="px-2 py-8 text-center">
        <div className="mb-1 text-[13.5px] font-medium text-ink-2">No site to configure yet</div>
        <p className="mx-auto mb-4 max-w-[42ch] text-[12.5px] leading-relaxed text-ink-3">
          These settings belong to a workspace. Add your first site and the wizard fills most of them in from
          what it reads there.
        </p>
        <Link href="/workspaces">
          <Button size="sm">Add a workspace</Button>
        </Link>
      </div>
    </Card>
  );
}

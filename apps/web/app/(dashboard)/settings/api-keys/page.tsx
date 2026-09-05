import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { ApiKeysPanel } from "@/components/dashboard/api-keys-panel";
import { getApiKeys } from "@/lib/queries/api-keys";
import { requireAuth } from "@/lib/auth/require-auth";
import { plural } from "@/lib/utils";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "API keys" };

/**
 * Keys for agents and scripts. Owners and admins create and revoke; editors
 * can see that keys exist but not act on them, the same split as Team.
 */
export default async function ApiKeysPage() {
  const { role } = await requireAuth();
  const canManage = role === "owner" || role === "admin";
  const keys = await getApiKeys();
  const active = keys.filter((k) => !k.revoked_at && (!k.expires_at || new Date(k.expires_at) > new Date()));

  return (
    <>
      <PageHead
        title="API keys"
        subtitle={
          <span>
            {plural(active.length, "active key")} ·{" "}
            <Link href="/settings/api-keys/agent-api" className="underline underline-offset-2 hover:text-ink">
              How the Agent API works
            </Link>
          </span>
        }
      />

      <SettingsTabs />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[1140px]">
          <ApiKeysPanel keys={keys} canManage={canManage} />
        </div>
      </div>
    </>
  );
}

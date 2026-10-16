import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/ui";
import { ApiKeysPanel } from "@/components/dashboard/api-keys-panel";
import { getApiKeys } from "@/lib/queries/api-keys";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { isSiteLimited, LIMITED_NO_KEYS } from "@/lib/team/access";
import { readMemberSites } from "@/lib/team/member-sites";
import { plural } from "@/lib/utils";
import { SettingsTabs } from "../settings-tabs";

export const metadata: Metadata = { title: "API keys" };

/**
 * Keys for agents and scripts. Owners and admins create and revoke; editors
 * can see that keys exist but not act on them, the same split as Team.
 */
export default async function ApiKeysPage({
  searchParams,
}: {
  /** `?blog=<workspace id>` opens the create dialog on a blog key for that site (Settings → Blog). */
  searchParams: Promise<{ blog?: string }>;
}) {
  const { role, accountId, user } = await requireAuth();
  const canManage = role === "owner" || role === "admin";
  // A key reaches every site on the account, so a member limited to some
  // sites does not create one (app/actions/api-keys.ts refuses it too).
  const limited = canManage && isSiteLimited(await readMemberSites(await createClient(), accountId, user.id));
  const [keys, workspaces, params] = await Promise.all([getApiKeys(), getWorkspaces(), searchParams]);
  const sites = workspaces.filter((w) => w.account_id === accountId).map((w) => ({ id: w.id, domain: w.domain }));
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
          <ApiKeysPanel
            keys={keys}
            canManage={canManage}
            canCreate={canManage && !limited}
            createNote={limited ? LIMITED_NO_KEYS : undefined}
            sites={sites}
            startBlogKeyFor={typeof params.blog === "string" ? params.blog : undefined}
          />
        </div>
      </div>
    </>
  );
}

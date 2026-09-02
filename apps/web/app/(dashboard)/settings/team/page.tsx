import type { Metadata } from "next";
import { getAgencyMembers } from "@/lib/queries/team";
import { getPendingInvites } from "@/lib/queries/team";
import { PageHead, Avatar, Icons, Chip, Card } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { InviteMemberForm } from "@/components/dashboard/invite-member-form";
import { CopyInviteLink } from "@/components/dashboard/copy-invite-link";
import { SettingsTabs } from "../settings-tabs";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const [members, invites] = await Promise.all([
    getAgencyMembers(),
    getPendingInvites(),
  ]);

  return (
    <>
      <PageHead
        title="Team"
        subtitle={<span>{plural(members.length, "member")}{invites.length > 0 ? ` · ${invites.length} pending` : ""}</span>}
        actions={<InviteMemberForm />}
      />

      <SettingsTabs />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <div className="max-w-[1140px] space-y-6">
          {/* Active members */}
          <Card flush>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Member", "Role", ""].map((h) => (
                    <th key={h} className="font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const name = (m.user?.raw_user_meta_data?.full_name as string) ?? m.user?.email ?? "Member";
                  const initials = name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();
                  return (
                    <tr key={m.id} className="hover:[&>td]:bg-panel">
                      <td className="px-3.5 py-3 border-b border-line-soft">
                        <span className="inline-flex items-center gap-2.5">
                          <Avatar initials={initials} color="av-c1" round />
                          <b>{name}</b>
                        </span>
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft"><Chip label={m.role} soft /></td>
                      <td className="px-3.5 py-3 border-b border-line-soft">
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3.5 py-8 text-center text-ink-3">No team members found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          {/* Pending invites */}
          {invites.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 text-ink-2">Pending invitations</h3>
              <Card flush>
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      {["Email", "Role", "Expires", "", ""].map((h, i) => (
                        <th key={h} className="font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((inv) => {
                      const expDate = new Date(inv.expires_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      });
                      const isExpired = new Date(inv.expires_at) < new Date();
                      return (
                        <tr key={inv.id} className="hover:[&>td]:bg-panel">
                          <td className="px-3.5 py-3 border-b border-line-soft font-medium">{inv.email}</td>
                          <td className="px-3.5 py-3 border-b border-line-soft"><Chip label={inv.role} soft /></td>
                          <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">
                            {isExpired ? <span className="text-red-500">Expired</span> : expDate}
                          </td>
                          <td className="px-3.5 py-3 border-b border-line-soft">
                            <Chip label="Pending" soft />
                          </td>
                          <td className="px-3.5 py-3 border-b border-line-soft text-right">
                            {!isExpired && <CopyInviteLink token={inv.token} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

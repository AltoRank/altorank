import type { Metadata } from "next";
import { getAgencyMembers, getPendingInvites } from "@/lib/queries/team";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { requireAuth } from "@/lib/auth/require-auth";
import { Avatar, Chip, Card } from "@/components/ui";
import { InviteMemberForm } from "@/components/dashboard/invite-member-form";
import { CopyInviteLink } from "@/components/dashboard/copy-invite-link";
import { MemberActions, RevokeInviteButton } from "@/components/settings/member-actions";
import { SettingsShell } from "../settings-shell";
import { plural } from "@/lib/utils";
import { accessLabel, canEditMember, canManageMembers, EDITOR_LIMITS_COPY, ROLE_LABEL, type Role } from "@/lib/team/access";
import { memberDisplayName, memberInitials } from "@/lib/team/display";

export const metadata: Metadata = { title: "Team" };

const th = "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left";
const td = "px-3.5 py-3 border-b border-line-soft";

export default async function TeamPage() {
  const [{ user, role }, members, invites, workspaces] = await Promise.all([
    requireAuth(),
    getAgencyMembers(),
    getPendingInvites(),
    // The roster is account-level on purpose: access is granted per site,
    // and the picker has to list every site there is to grant.
    getWorkspaces(),
  ]);
  const manager = canManageMembers(role);
  const namesById = new Map(workspaces.map((w) => [w.id, w.name]));
  const pickerWorkspaces = workspaces.map((w) => ({ id: w.id, name: w.name, domain: w.domain }));

  return (
    <SettingsShell
      title="Team"
      subtitle={
        <span>
          {plural(members.length, "member")}
          {invites.length > 0 ? ` · ${invites.length} pending` : ""}
          {" · "}
          {EDITOR_LIMITS_COPY}
        </span>
      }
      actions={manager ? <InviteMemberForm /> : undefined}
    >
      {!manager && (
        <p className="m-0 text-[12.5px] text-ink-3">
          You are signed in as an editor. {EDITOR_LIMITS_COPY} Ask an owner or admin to change who is on this account.
        </p>
      )}

      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Member", "Role", "Access", ""].map((h, i) => (
                <th key={h || i} className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const name = memberDisplayName(m.user);
              const initials = memberInitials(m.user);
              const editable = canEditMember({ userId: user.id, role }, { userId: m.user_id, role: m.role });
              return (
                <tr key={m.id} className="hover:[&>td]:bg-panel">
                  <td className={td}>
                    <span className="inline-flex items-center gap-2.5">
                      <Avatar initials={initials} color="av-c1" round />
                      <b>{name}</b>
                      {m.user_id === user.id && <span className="text-[11.5px] text-ink-3">you</span>}
                    </span>
                  </td>
                  <td className={td}>
                    <Chip label={ROLE_LABEL[m.role as Role] ?? m.role} soft />
                  </td>
                  <td className={`${td} text-ink-2`}>{accessLabel(m.workspace_ids, namesById)}</td>
                  <td className={`${td} text-right`}>
                    {editable && (
                      <MemberActions
                        memberId={m.id}
                        name={name}
                        role={m.role as Role}
                        workspaceIds={m.workspace_ids}
                        workspaces={pickerWorkspaces}
                        actorIsOwner={role === "owner"}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3.5 py-8 text-center text-ink-3">
                  No team members found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {invites.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2 text-ink-2">Pending invitations</h3>
          <Card flush>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Email", "Role", "Access", "Expires", ""].map((h, i) => (
                    <th key={h || i} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => {
                  const expDate = new Date(inv.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  const isExpired = new Date(inv.expires_at) < new Date();
                  return (
                    <tr key={inv.id} className="hover:[&>td]:bg-panel">
                      <td className={`${td} font-medium`}>{inv.email}</td>
                      <td className={td}>
                        <Chip label={ROLE_LABEL[inv.role] ?? inv.role} soft />
                      </td>
                      <td className={`${td} text-ink-2`}>{accessLabel(inv.workspace_ids, namesById)}</td>
                      <td className={`${td} font-mono text-xs text-ink-2`}>
                        {isExpired ? <span className="text-err-ink">Expired</span> : expDate}
                      </td>
                      <td className={`${td} text-right`}>
                        <span className="inline-flex items-center gap-2">
                          {!isExpired && <CopyInviteLink token={inv.token} />}
                          {manager && <RevokeInviteButton inviteId={inv.id} email={inv.email} />}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </SettingsShell>
  );
}

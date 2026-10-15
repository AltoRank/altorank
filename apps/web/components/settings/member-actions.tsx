"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Dialog } from "@/components/ui";
import { updateMemberAccess, removeMember, revokeInvite } from "@/app/actions/team";
import {
  LIMITED_EVERY_SITE_TARGET,
  LIMITED_REMOVE_REACH,
  LIMITED_REVOKE_REACH,
  LIMITED_ROLE_REACH,
  ROLE_LABEL,
  type Role,
} from "@/lib/team/access";
import type { Workspace } from "@/lib/types";
import { WorkspaceAccessPicker } from "./workspace-access-picker";
import { inputClass } from "./fields";

/**
 * Edit access / remove, for one row of the members table. Rendered only when
 * the signed-in member may act on this row (`canEditMember`); the actions
 * check again on the server.
 */
export function MemberActions({
  memberId,
  name,
  role,
  workspaceIds,
  workspaces,
  actorIsOwner,
  limited = false,
  canChangeRole = true,
  canChangeSites = true,
}: {
  memberId: string;
  name: string;
  role: Role;
  workspaceIds: string[] | null;
  workspaces: Pick<Workspace, "id" | "name" | "domain">[];
  actorIsOwner: boolean;
  /** The signed-in member holds only some sites (lib/team/access.ts). */
  limited?: boolean;
  /** False when this member reaches sites the signed-in member does not (role and Remove). */
  canChangeRole?: boolean;
  /** False when this member has every site and the signed-in member does not. */
  canChangeSites?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextRole, setNextRole] = useState<Role>(role);
  // A limited member's picker lists their own sites only; the target's other
  // sites are kept by the server, so they are not part of the selection.
  const [access, setAccess] = useState<string[]>(
    (workspaceIds ?? []).filter((id) => !limited || workspaces.some((w) => w.id === id)),
  );
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      try {
        await updateMemberAccess(memberId, nextRole, access);
        toast.success(`Updated ${name}.`);
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update.");
      }
    });
  }

  function remove() {
    if (!confirm(`Remove ${name} from this account? They lose access immediately; nothing they wrote is deleted.`)) return;
    start(async () => {
      try {
        await removeMember(memberId);
        toast.success(`Removed ${name}.`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not remove.");
      }
    });
  }

  const roles: Role[] = actorIsOwner ? ["owner", "admin", "editor"] : ["admin", "editor"];

  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" onClick={() => setOpen(true)} disabled={pending}>
        Edit access
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={remove}
        disabled={pending || !canChangeRole}
        title={canChangeRole ? undefined : LIMITED_REMOVE_REACH}
      >
        Remove
      </Button>

      <Dialog open={open} onOpenChange={setOpen} title={`Access for ${name}`} description="Role decides what they can do; workspace access decides which workspaces they see.">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Role</span>
            <select
              className={inputClass}
              value={nextRole}
              disabled={!canChangeRole}
              onChange={(e) => setNextRole(e.target.value as Role)}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {!canChangeRole && (
              <span className="text-[11.5px] text-ink-3">{LIMITED_ROLE_REACH}</span>
            )}
          </label>
          {canChangeSites ? (
            <WorkspaceAccessPicker workspaces={workspaces} value={access} onChange={setAccess} limited={limited} />
          ) : (
            <p className="m-0 text-[12.5px] text-ink-3">{LIMITED_EVERY_SITE_TARGET}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="accent" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function RevokeInviteButton({
  inviteId,
  email,
  canRevoke = true,
}: {
  inviteId: string;
  email: string;
  /** False when the invite gives sites the signed-in member does not have. */
  canRevoke?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending || !canRevoke}
      title={canRevoke ? undefined : LIMITED_REVOKE_REACH}
      onClick={() =>
        start(async () => {
          try {
            await revokeInvite(inviteId);
            toast.success(`Invite for ${email} revoked.`);
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Could not revoke.");
          }
        })
      }
    >
      Revoke
    </Button>
  );
}

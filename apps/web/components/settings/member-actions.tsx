"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Dialog } from "@/components/ui";
import { updateMemberAccess, removeMember, revokeInvite } from "@/app/actions/team";
import { ROLE_LABEL, type Role } from "@/lib/team/access";
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
}: {
  memberId: string;
  name: string;
  role: Role;
  workspaceIds: string[] | null;
  workspaces: Pick<Workspace, "id" | "name" | "domain">[];
  actorIsOwner: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextRole, setNextRole] = useState<Role>(role);
  const [access, setAccess] = useState<string[]>(workspaceIds ?? []);
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
      <Button size="sm" variant="ghost" onClick={remove} disabled={pending}>
        Remove
      </Button>

      <Dialog open={open} onOpenChange={setOpen} title={`Access for ${name}`} description="Role decides what they can do; workspace access decides which sites they see.">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Role</span>
            <select className={inputClass} value={nextRole} onChange={(e) => setNextRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <WorkspaceAccessPicker workspaces={workspaces} value={access} onChange={setAccess} />
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

export function RevokeInviteButton({ inviteId, email }: { inviteId: string; email: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
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

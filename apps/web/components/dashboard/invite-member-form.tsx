"use client";

import { useRef, useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { inviteMember } from "@/app/actions/team";
import { Button, Icons, Dialog } from "@/components/ui";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { WorkspaceAccessPicker } from "@/components/settings/workspace-access-picker";
import { INVITABLE_ROLES, ROLE_LABEL, EDITOR_LIMITS_COPY } from "@/lib/team/access";
import { inputClass } from "@/components/settings/fields";

/**
 * Invite, with a role and a choice of sites.
 *
 * A dialog rather than the inline row it replaced: the workspace list needs
 * height, and the head row is one line tall. Owner is not offered - ownership
 * is changed on an existing member by an owner, never granted by email.
 */
export function InviteMemberForm() {
  const { workspaces } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <>
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Icons.plus size={14} />
        Invite member
      </Button>

      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)} title="Invite a team member" description="They get an email with a link that works once and expires in seven days.">
        <form
          ref={formRef}
          className="flex flex-col gap-4"
          action={(fd) =>
            startTransition(async () => {
              try {
                await inviteMember(fd);
                toast.success(`Invite sent to ${String(fd.get("email") ?? "")}.`);
                formRef.current?.reset();
                setAccess([]);
                setOpen(false);
                router.refresh();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not send the invite.");
              }
            })
          }
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Email</span>
            <input name="email" type="email" required placeholder="colleague@example.com" className={inputClass} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Role</span>
            <select name="role" defaultValue="editor" className={inputClass}>
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <span className="text-[11.5px] text-ink-3">{EDITOR_LIMITS_COPY}</span>
          </label>
          <WorkspaceAccessPicker workspaces={workspaces} value={access} onChange={setAccess} />
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Sending…" : "Send invite"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

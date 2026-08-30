"use client";

import { useRef, useTransition, useState } from "react";
import { inviteMember } from "@/app/actions/team";
import { Button, Icons } from "@/components/ui";

export function InviteMemberForm() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Icons.plus size={14} />
        Invite member
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      className="flex items-end gap-2"
      action={(fd) =>
        startTransition(async () => {
          await inviteMember(fd);
          formRef.current?.reset();
          setOpen(false);
        })
      }
    >
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">
          Email
        </label>
        <input
          name="email"
          type="email"
          required
          placeholder="colleague@example.com"
          className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft w-[240px]"
        />
      </div>
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">
          Role
        </label>
        <select
          name="role"
          defaultValue="editor"
          className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft"
        >
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <Button type="submit" variant="accent" disabled={pending}>
        {pending ? "Sending…" : "Send invite"}
      </Button>
      <Button type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
  );
}

"use client";

import { useTransition, useRef, useState } from "react";
import { createExchangeRequest } from "@/app/actions/exchange";
import { Button, Icons } from "@/components/ui";

type Ws = { id: string; name: string };

type Props = {
  /** All of them: which site the link should point at is the request. */
  workspaces: Ws[];
};

export function ExchangeRequestForm({ workspaces }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const formRef = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <Button variant="accent" onClick={() => setOpen(true)}>
        <Icons.plus size={14} />
        Request link
      </Button>
    );
  }

  return (
    <form
      ref={formRef}
      className="flex items-end gap-2 flex-wrap"
      action={(fd) =>
        startTransition(async () => {
          // agencyId is derived server-side from the session now (IDOR fix).
          await createExchangeRequest(
            workspaceId,
            fd.get("url") as string,
            fd.get("keyword") as string,
            fd.get("topic") as string,
          );
          formRef.current?.reset();
          setOpen(false);
        })
      }
    >
      {workspaces.length > 1 && (
        <div>
          <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">Workspace</label>
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">Target URL</label>
        <input
          name="url"
          type="url"
          required
          placeholder="https://example.com/page"
          className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft w-[200px]"
        />
      </div>
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">Keyword</label>
        <input
          name="keyword"
          required
          placeholder="seo tool"
          className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft w-[140px]"
        />
      </div>
      <div>
        <label className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block">Topic</label>
        <input
          name="topic"
          required
          placeholder="SEO automation"
          className="px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft w-[140px]"
        />
      </div>
      <Button type="submit" variant="accent" disabled={pending}>
        {pending ? "Submitting…" : "Submit request"}
      </Button>
      <Button type="button" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}

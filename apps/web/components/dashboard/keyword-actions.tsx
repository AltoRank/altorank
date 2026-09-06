"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { useWorkspace } from "@/components/dashboard/workspace-context";
import { createKeyword } from "@/app/actions/keywords";
import type { Workspace, Keyword } from "@/lib/types";
import { ResearchButtons } from "@/components/dashboard/keyword-research/research-buttons";

interface KeywordActionsProps {
  workspaces: Workspace[];
  keywords?: Keyword[];
}

export function KeywordActions({ workspaces, keywords = [] }: KeywordActionsProps) {
  // Follows the sidebar switcher rather than offering its own choice.
  // `workspaces` remains the fallback for the first render, before the
  // provider has resolved an active row.
  const { active } = useWorkspace();
  const target = active ?? workspaces[0] ?? null;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const onboarding = useOnboarding();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      // The workspace field is no longer a `required` <select>, so nothing in
      // the browser stops a submit when there is no workspace to bind to.
      if (!fd.get("workspace_id")) {
        throw new Error("Add a site before tracking keywords for it.");
      }
      await createKeyword(fd);
      setOpen(false);
      onboarding?.completeStep("add-keywords");
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button onClick={() => {
        const escape = (v: string) => v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        const header = ["Keyword","Intent","Volume","Difficulty","Status"].join(",");
        const body = keywords.map((k) => [
          escape(k.term), k.intent, k.volume == null ? "" : String(k.volume), k.difficulty == null ? "" : String(k.difficulty), k.status,
        ].join(",")).join("\n");
        const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const el = document.createElement("a");
        el.href = url;
        el.download = `keywords-${new Date().toISOString().split("T")[0]}.csv`;
        el.click();
        URL.revokeObjectURL(url);
      }}>
        <Icons.download size={14} />
        Export CSV
      </Button>
      <Button
        data-onboarding="add-keywords"
        onClick={() => setOpen(true)}
      >
        <Icons.plus size={14} />
        Add keyword
      </Button>
      <ResearchButtons />

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add keyword"
        description="Track a new keyword across your workspace."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {/* Shown, not chosen: the sidebar switcher decides which site this
              is for, and a second picker here could file the keyword under a
              workspace the rest of the screen is not showing. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
            <input type="hidden" name="workspace_id" value={target?.id ?? ""} />
            <div className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink-2">
              {target?.name ?? "No workspace"}
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Keyword</span>
            <input
              name="term"
              required
              placeholder="best crm software"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Intent</span>
            <select
              name="intent"
              defaultValue="info"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors"
            >
              <option value="info">Informational</option>
              <option value="commercial">Commercial</option>
              <option value="transactional">Transactional</option>
              <option value="navigational">Navigational</option>
            </select>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Adding…" : "Add keyword"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

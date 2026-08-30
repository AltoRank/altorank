"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import { triggerGeneration } from "@/app/actions/generate";
import type { Workspace, Article } from "@/lib/types";

interface ArticleActionsProps {
  workspace: Workspace;
  articles?: Article[];
}

export function ArticleActions({ workspace, articles = [] }: ArticleActionsProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const onboarding = useOnboarding();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      const fd = new FormData(e.currentTarget);
      const keyword = fd.get("keyword") as string;
      const title = (fd.get("title") as string) || undefined;
      await triggerGeneration(workspace.id, keyword, title);
      setOpen(false);
      onboarding?.completeStep("generate-article");
      router.refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {workspace.domain && (
        <Button onClick={() => window.open(`https://${workspace.domain}`, "_blank")}>
          <Icons.externalLink size={14} />
          Open site
        </Button>
      )}
      <Button onClick={() => {
        const escape = (v: string) => v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        const header = ["Title","Keyword","Status","Score","Volume","Position","CMS","Updated"].join(",");
        const body = articles.map((a) => [
          escape(a.title), escape(a.keyword), a.status, String(a.seo_score),
          String(a.volume), a.position ? String(a.position) : "", a.cms ?? "",
          a.updated_at ? new Date(a.updated_at).toISOString().split("T")[0] : "",
        ].join(",")).join("\n");
        const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const el = document.createElement("a");
        el.href = url;
        el.download = `articles-${workspace.domain}-${new Date().toISOString().split("T")[0]}.csv`;
        el.click();
        URL.revokeObjectURL(url);
      }}>
        <Icons.download size={14} />
        Export
      </Button>
      <Button
        variant="accent"
        data-onboarding="ask-ai"
        onClick={() => setOpen(true)}
      >
        <Icons.sparkle size={14} />
        New article
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Generate article"
        description={`Create SEO-optimized content for ${workspace.name}.`}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Target keyword</span>
            <input
              name="keyword"
              required
              placeholder="best project management tools"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">
              Title <span className="text-ink-3 font-normal">(optional)</span>
            </span>
            <input
              name="title"
              placeholder="Auto-generated from keyword"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Generating…" : "Generate"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

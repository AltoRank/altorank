"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Icons, Dialog } from "@/components/ui";
import { useOnboarding } from "@/components/onboarding/use-onboarding";
import type { Workspace, Article } from "@/lib/types";
import { suggestKeywords, type KeywordSuggestion } from "@/app/actions/recommendations";

interface ArticleActionsProps {
  /** One workspace (detail page) or all of them (the global Articles page). */
  workspaces: Workspace[];
  articles?: Article[];
}

export function ArticleActions({ workspaces, articles = [] }: ArticleActionsProps) {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The workspace's own scored queue: striking distance first, then volume
  // against difficulty, intent and how well the term fits the site. The same
  // ranking the unattended pipeline uses, so a person and the cron agree.
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[]>([]);
  const [keyword, setKeyword] = useState("");
  const [loadingSuggestions, startSuggestions] = useTransition();

  useEffect(() => {
    if (!open || !workspaceId) return;
    startSuggestions(async () => {
      try {
        setSuggestions(await suggestKeywords(workspaceId, 8));
      } catch {
        setSuggestions([]);
      }
    });
  }, [open, workspaceId]);
  const onboarding = useOnboarding();
  const router = useRouter();

  /**
   * Talks to /api/generate, the same route the editor's regenerate uses.
   *
   * It used to call `triggerGeneration`, a server action that inserted an
   * article row and a `generation_jobs` row and returned - and nothing
   * anywhere consumed that job. The modal closed, the list showed "Drafting",
   * and the row stayed at zero words forever. Found by clicking the button
   * during the pre-launch walkthrough and watching nothing arrive. Two
   * implementations of one behaviour, one of them dead, which is the exact
   * drift lib/content/generate.ts was extracted to prevent.
   *
   * The stream is held open on purpose: generation runs inside this request,
   * so the modal stays up with progress until the draft exists. Closing the
   * tab mid-write abandons the run, which is honest - there is no worker to
   * hand it to - and the cron path exists for unattended generation.
   */
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const fd = new FormData(e.currentTarget);
      const keyword = fd.get("keyword") as string;
      const title = (fd.get("title") as string) || undefined;

      setPhase("Researching the live SERP…");
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspace.id, keyword, title }),
      });
      if (!res.ok || !res.body) throw new Error("Generation failed to start");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let articleId: string | null = null;
      let failed: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "research") setPhase("Writing the draft…");
            if (data.type === "chunk") setPhase("Writing the draft…");
            if (data.type === "factcheck") setPhase("Checking claims…");
            if (data.type === "complete") articleId = data.articleId;
            if (data.type === "error") failed = data.error;
          } catch {
            // A malformed frame is dropped; the terminal events decide the outcome.
          }
        }
      }

      if (failed) throw new Error(failed);
      if (!articleId) throw new Error("The stream ended without a draft.");

      onboarding?.completeStep("generate-article");
      setOpen(false);
      router.push(`/content/${articleId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setPending(false);
      setPhase(null);
    }
  }

  return (
    <>
      {workspaces.length === 1 && workspace?.domain && (
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
        el.download = `articles-${workspaces.length === 1 ? workspace.domain : "all"}-${new Date().toISOString().split("T")[0]}.csv`;
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
        description="Researched against the live SERP, written in the workspace's voice, held for your review."
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {workspaces.length > 1 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Workspace</span>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                disabled={pending}
                className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink outline-none focus:border-accent transition-colors disabled:opacity-50"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Target keyword</span>
            <input
              name="keyword"
              required
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Pick one below, or type your own"
              className="px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors"
            />
          </label>

          {(loadingSuggestions || suggestions.length > 0) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">
                Best next from this workspace{" "}
                <span className="font-normal text-ink-3">ranked by what it can win</span>
              </span>
              {loadingSuggestions ? (
                <div className="text-[12px] text-ink-3">Reading the keyword queue…</div>
              ) : (
                <div className="flex flex-col rounded-lg border border-line overflow-hidden">
                  {suggestions.map((s, i) => (
                    <button
                      key={s.term}
                      type="button"
                      onClick={() => setKeyword(s.term)}
                      className={`flex items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-panel ${i > 0 ? "border-t border-line-soft" : ""} ${keyword === s.term ? "bg-accent-soft" : ""}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{s.term}</span>
                        <span className="block truncate text-[11px] text-ink-3">
                          {s.action === "refresh" ? "refresh what you have · " : ""}
                          {s.position ? `position ${s.position} · ` : ""}
                          {s.intent !== "info" ? `${s.intent} intent · ` : ""}
                          {s.reason}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-ink-2">
                        {s.volume.toLocaleString()}/mo
                        {s.difficulty !== null ? ` · KD ${s.difficulty}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

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

          {pending && phase && (
            <div className="flex items-center gap-2 py-1 text-[12.5px] text-ink-2">
              <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              {phase}
            </div>
          )}
          {error && (
            <div className="py-1 text-[12.5px] text-err-ink">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => setOpen(false)} disabled={pending}>
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

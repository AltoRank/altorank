"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { TabRow } from "@/components/ui/tab-row";
import { Icons } from "@/components/ui/icons";
import { cn, plural } from "@/lib/utils";
import {
  analyzeNow,
  cancelTask,
  dismissCandidate,
  generateBrief,
  saveBrief,
  scheduleCandidate,
} from "@/app/actions/refresh";
import { describeEvidence } from "@/lib/refresh/brief";
import {
  OPPORTUNITY_LABELS,
  type Opportunity,
  type RefreshCandidate,
  type RefreshTask,
  type ReviewStatus,
} from "@/lib/refresh/types";

export type CandidateRow = RefreshCandidate & { title: string; task: RefreshTask | null };

export type ExecutionRow = {
  id: string;
  review_status: ReviewStatus;
  created_at: string;
  pushed_at: string | null;
  published_url: string | null;
  url: string;
  opportunity: Opportunity;
  title: string;
  changed: number;
  issues: number;
};

type Props = {
  workspaceId: string;
  gscConnected: boolean;
  cms: { connected: boolean; labels: string[]; updatable: boolean };
  refresh: { enabled: boolean; days: number[]; lastAnalyzedAt: string | null };
  candidates: CandidateRow[];
  executions: ExecutionRow[];
};

const TABS: { id: "all" | ReviewStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "awaiting_review", label: "Awaiting review" },
  { id: "pushed", label: "Pushed" },
  { id: "rejected", label: "Rejected" },
];

const REVIEW_PILL: Record<ReviewStatus, { status: string; label: string }> = {
  awaiting_review: { status: "review", label: "Awaiting review" },
  pushed: { status: "live", label: "Pushed" },
  rejected: { status: "error", label: "Rejected" },
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

export function OpportunityBadge({ opportunity }: { opportunity: Opportunity }) {
  const tone: Record<Opportunity, string> = {
    almost_there: "bg-accent-soft text-accent-ink",
    ctr_gap: "bg-warn-soft text-warn-ink",
    declining: "bg-err-soft text-err-ink",
    content_gap: "bg-panel-2 text-ink-2",
    thin: "bg-panel-2 text-ink-2",
  };
  return (
    <span className={cn("inline-flex px-[7px] py-px rounded-full text-[11px] font-medium whitespace-nowrap", tone[opportunity])}>
      {OPPORTUNITY_LABELS[opportunity]}
    </span>
  );
}

function Blocker({ title, body, href, cta }: { title: string; body: string; href?: string; cta?: string }) {
  return (
    <div className="rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px]">
      <div className="font-medium text-ink mb-0.5">{title}</div>
      <p className="text-ink-3 leading-relaxed m-0">{body}</p>
      {href && cta && (
        <Link href={href} className="inline-block mt-2 text-accent-ink underline decoration-line underline-offset-[3px]">
          {cta}
        </Link>
      )}
    </div>
  );
}

export function ImprovementsView({ workspaceId, gscConnected, cms, refresh, candidates, executions }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"all" | ReviewStatus>("all");
  const [analyzing, startAnalyze] = useTransition();

  const visible = tab === "all" ? executions : executions.filter((e) => e.review_status === tab);
  const count = (s: ReviewStatus) => executions.filter((e) => e.review_status === s).length;

  function runAnalyze() {
    startAnalyze(async () => {
      try {
        const r = await analyzeNow(workspaceId);
        if (r.reason === "gsc_not_connected") {
          toast.error("Search Console is not connected, so there is nothing to analyse.");
        } else {
          toast.success(
            `${plural(r.pages, "page")} checked: ${plural(r.created, "new candidate")}, ${r.refreshed} refreshed`,
          );
          router.refresh();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Analysis failed");
      }
    });
  }

  return (
    <>
      <TabRow
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: t.id === "all" ? executions.length : count(t.id) }))}
        activeTab={tab}
        onChange={(id) => setTab(id as typeof tab)}
        actions={
          <Button size="sm" onClick={runAnalyze} disabled={analyzing || !gscConnected} title={gscConnected ? undefined : "Connect Search Console first"}>
            <Icons.refresh size={13} />
            {analyzing ? "Analysing…" : "Analyze now"}
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll space-y-5">
        <p className="text-[13px] text-ink-3 m-0 max-w-[72ch]">
          Review rewrites the system has produced for your existing articles. Approve the changes you like and push
          them to your CMS.
        </p>

        {(!gscConnected || !cms.connected || (cms.connected && !cms.updatable) || !refresh.enabled) && (
          <div className="grid gap-3 md:grid-cols-2">
            {!gscConnected && (
              <Blocker
                title="Search Console is not connected"
                body="Every opportunity here is read from impressions, clicks and positions. Without Search Console nothing can be detected, so the candidate list stays empty and Analyze now has nothing to read."
                href="/connect"
                cta="Connect Search Console"
              />
            )}
            {!cms.connected && (
              <Blocker
                title="No CMS connected"
                body="Rewrites can still be produced and reviewed here. What cannot happen is Push to site: without a connection you get Copy HTML and Download Markdown on each reviewed rewrite instead."
                href="/connect"
                cta="Connect a CMS"
              />
            )}
            {cms.connected && !cms.updatable && (
              <Blocker
                title={`${cms.labels.join(", ")} cannot edit an existing post yet`}
                body="The connection can publish new articles but not update one in place, and publishing a second copy of a page would be worse than no push. Reviewed rewrites offer Copy HTML and Download Markdown instead."
              />
            )}
            {!refresh.enabled && (
              <Blocker
                title="Scheduled rewrites are off for this site"
                body="Candidates can be found and scheduled, but the schedule only runs once it is switched on. One improvement per scheduled day, using one slot of your article pace."
                href="/settings/refresh"
                cta="Open settings"
              />
            )}
          </div>
        )}

        <Card
          title="Rewrites"
          meta={
            refresh.enabled && refresh.days.length
              ? `runs ${refresh.days.map((d) => DAY_LABELS[d]).join(" and ")}`
              : refresh.lastAnalyzedAt
                ? `last analysed ${fmtDate(refresh.lastAnalyzedAt)}`
                : undefined
          }
          flush
        >
          {visible.length === 0 ? (
            <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">
              {executions.length === 0
                ? "No rewrites yet. Schedule a candidate below and the next enabled day produces one for review."
                : "Nothing in this tab."}
            </div>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Article", "Opportunity", "Status", "Changes", "Generated"].map((h) => (
                    <th
                      key={h}
                      className={cn(
                        "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left",
                        (h === "Generated" || h === "Changes") && "text-right",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => (
                  <tr key={e.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                      <Link
                        href={`/improvements/${e.id}`}
                        className="block truncate font-medium hover:text-accent-ink hover:underline decoration-line underline-offset-[3px]"
                      >
                        {e.title}
                      </Link>
                      <div className="text-[11px] text-ink-3 mt-0.5 truncate font-mono">{e.url.replace(/^https?:\/\//, "")}</div>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft"><OpportunityBadge opportunity={e.opportunity} /></td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <StatusPill status={REVIEW_PILL[e.review_status].status} label={REVIEW_PILL[e.review_status].label} />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {plural(e.changed, "block")}
                      {e.issues > 0 && <span className="ml-1.5 text-warn-ink">· {plural(e.issues, "check")}</span>}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{fmtDate(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Candidates" meta={candidates.length ? plural(candidates.length, "page") : undefined} flush>
          {candidates.length === 0 ? (
            <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">
              {gscConnected
                ? "Nothing flagged. Analyze now reads the last 28 days of Search Console against your pages; the weekly pass does the same."
                : "Connect Search Console to find pages worth rewriting."}
            </div>
          ) : (
            <ul className="m-0 p-0 list-none divide-y divide-line-soft">
              {candidates.map((c) => (
                <CandidateItem key={c.id} candidate={c} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function CandidateItem({ candidate: c }: { candidate: CandidateRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState(c.brief ?? "");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pending, start] = useTransition();

  const act = (label: string, fn: () => Promise<unknown>) =>
    start(async () => {
      try {
        await fn();
        toast.success(label);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Something went wrong");
      }
    });

  const evidence = describeEvidence(c.evidence);

  return (
    <li className="px-[18px] py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <OpportunityBadge opportunity={c.opportunity} />
            <span className="font-medium truncate">{c.title}</span>
          </div>
          <a href={c.url} target="_blank" rel="noreferrer" className="block mt-0.5 text-[11px] font-mono text-ink-3 truncate hover:underline">
            {c.url.replace(/^https?:\/\//, "")}
          </a>
          {evidence.length > 0 && (
            <div className="mt-1.5 text-[12px] text-ink-3">{evidence.join(" · ")}</div>
          )}
          {c.task && (
            <div className={cn("mt-1.5 text-[12px]", c.task.status === "failed" ? "text-err-ink" : "text-ink-2")}>
              {c.task.status === "scheduled" && `Scheduled for ${c.task.scheduled_for}; runs on the next enabled day on or after that.`}
              {c.task.status === "running" && "Rewriting now…"}
              {c.task.status === "failed" && `Last run failed: ${c.task.error ?? "unknown error"}. Reschedule to try again.`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            <Icons.edit size={12} />
            Brief{c.brief_status === "ready" ? "" : c.brief_status === "failed" ? " (failed)" : " (none)"}
          </Button>
          {c.task && c.task.status !== "running" ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("Unscheduled", () => cancelTask(c.task!.id))}>
              Cancel
            </Button>
          ) : (
            <>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Run on or after"
                className="bg-bg border border-line rounded-[6px] px-2 py-1 text-[12px] font-mono"
              />
              <Button size="sm" disabled={pending || !date} onClick={() => act("Scheduled", () => scheduleCandidate(c.id, date))}>
                Schedule
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("Dismissed", () => dismissCandidate(c.id))}>
            Dismiss
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-[8px] border border-line bg-panel p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-[0.06em] text-ink-3">Brief: what the rewrite will follow</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                act("Brief written", async () => {
                  const text = await generateBrief(c.id);
                  setBrief(text);
                })
              }
            >
              <Icons.sparkle size={12} />
              {c.brief ? "Regenerate" : "Generate brief"}
            </Button>
          </div>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={8}
            placeholder="What to strengthen, which questions to add, what to keep. Generate one from the evidence or write your own."
            className="w-full bg-bg border border-line rounded-[6px] px-2.5 py-2 text-[12.5px] leading-relaxed font-mono"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={pending || brief === (c.brief ?? "")} onClick={() => act("Brief saved", () => saveBrief(c.id, brief))}>
              Save brief
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

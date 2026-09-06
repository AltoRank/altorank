"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icons } from "@/components/ui/icons";
import { cn, plural } from "@/lib/utils";
import { summarizeDecisions } from "@/lib/refresh/hunks";
import { DecideAllButtons, KeepRejectButtons, KeptCounter, sanitizeHunkHtml } from "@/components/dashboard/review/hunk-controls";
import { describeEvidence } from "@/lib/refresh/brief";
import {
  exportExecutionAction,
  pushExecutionAction,
  rejectExecution,
  saveExecutionDecisions,
} from "@/app/actions/refresh";
import type {
  Evidence,
  ExecutionDecisions,
  Hunk,
  HunkDecision,
  ReviewStatus,
  ValidationIssue,
} from "@/lib/refresh/types";

type Props = {
  executionId: string;
  reviewStatus: ReviewStatus;
  hunks: Hunk[];
  issues: ValidationIssue[];
  before: { title: string | null; metaDescription: string | null };
  after: { title: string | null; metaDescription: string | null };
  initialDecisions: ExecutionDecisions;
  /** Why "Push to site" is unavailable, or null when it can run. */
  pushBlocker: string | null;
  destinationLabel: string | null;
  publishedUrl: string | null;
  brief: string | null;
  evidence: Evidence;
};

export function ReviewExecution({
  executionId,
  reviewStatus,
  hunks,
  issues,
  before,
  after,
  initialDecisions,
  pushBlocker,
  destinationLabel,
  publishedUrl,
  brief,
  evidence,
}: Props) {
  const router = useRouter();
  const editable = reviewStatus === "awaiting_review";
  const [decisions, setDecisions] = useState<Record<string, HunkDecision>>(initialDecisions.decisions);
  const [edited, setEdited] = useState<Record<string, string>>(initialDecisions.edited);
  const [fields, setFields] = useState<ExecutionDecisions["fields"]>(initialDecisions.fields);
  const [editing, setEditing] = useState<string | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [pending, start] = useTransition();
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");

  const current: ExecutionDecisions = useMemo(() => ({ decisions, edited, fields }), [decisions, edited, fields]);
  const summary = summarizeDecisions(hunks, decisions, edited);
  const titleChanged = (after.title ?? "") !== (before.title ?? "") && Boolean(after.title);
  const metaChanged = (after.metaDescription ?? "") !== (before.metaDescription ?? "") && Boolean(after.metaDescription);

  // Autosave, debounced. Nothing here reaches the site: it is the reviewer's
  // notes being kept so a reload does not lose them.
  const first = useRef(true);
  useEffect(() => {
    if (!editable) return;
    if (first.current) {
      first.current = false;
      return;
    }
    setSaveState("dirty");
    const t = setTimeout(async () => {
      setSaveState("saving");
      try {
        await saveExecutionDecisions(executionId, current);
        setSaveState("saved");
      } catch (err) {
        setSaveState("dirty");
        toast.error(err instanceof Error ? err.message : "Could not save your decisions");
      }
    }, 600);
    return () => clearTimeout(t);
  }, [current, editable, executionId]);

  const decide = (id: string, d: HunkDecision) => setDecisions((prev) => ({ ...prev, [id]: d }));
  const decideAll = (d: HunkDecision) =>
    setDecisions(Object.fromEntries(hunks.filter((h) => h.kind !== "unchanged").map((h) => [h.id, d])));

  function push() {
    start(async () => {
      try {
        const r = await pushExecutionAction(executionId, current);
        toast.success(`Pushed ${r.kept} of ${plural(r.total, "change")} to ${destinationLabel ?? "your site"}`);
        setConfirmPush(false);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Push failed");
        setConfirmPush(false);
      }
    });
  }

  function reject() {
    start(async () => {
      try {
        await rejectExecution(executionId);
        toast.success("Rewrite rejected. The page is unchanged.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not reject");
      }
    });
  }

  function exportAs(kind: "html" | "md") {
    start(async () => {
      try {
        const out = await exportExecutionAction(executionId, editable ? current : undefined);
        if (kind === "html") {
          await navigator.clipboard.writeText(out.html);
          toast.success("HTML copied. Paste it into your CMS editor's HTML view.");
        } else {
          const blob = new Blob([out.markdown], { type: "text/markdown;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${(out.title || "rewrite").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "rewrite"}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Export failed");
      }
    });
  }

  const visibleHunks = showUnchanged ? hunks : hunks.filter((h) => h.kind !== "unchanged");
  const unchangedCount = hunks.length - summary.total;

  return (
    <>
      {/* Decision bar */}
      <div className="px-8 py-2.5 border-b border-line bg-bg flex items-center gap-3 text-[13px]">
        <KeptCounter kept={summary.kept} total={summary.total} />
        {summary.undecided > 0 && editable && (
          <span className="text-ink-3">{plural(summary.undecided, "block")} undecided (kept as original)</span>
        )}
        {editable && (
          <span className="text-[11.5px] text-ink-4 font-mono">
            {saveState === "saved" ? "saved" : saveState === "saving" ? "saving…" : "unsaved"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {editable && <DecideAllButtons onDecideAll={decideAll} />}
          <Button size="sm" variant="ghost" onClick={() => exportAs("html")} disabled={pending}>
            Copy HTML
          </Button>
          <Button size="sm" variant="ghost" onClick={() => exportAs("md")} disabled={pending}>
            <Icons.download size={12} />
            Download Markdown
          </Button>
          {editable && (
            <>
              <Button size="sm" variant="ghost" onClick={reject} disabled={pending}>
                Reject rewrite
              </Button>
              <Button
                size="sm"
                variant="accent"
                disabled={pending || Boolean(pushBlocker) || summary.kept === 0}
                title={pushBlocker ?? (summary.kept === 0 ? "Keep at least one change first" : undefined)}
                onClick={() => setConfirmPush(true)}
              >
                <Icons.upload size={12} />
                Push to site
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll space-y-5">
        {reviewStatus !== "awaiting_review" && (
          <div className="rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px]">
            {reviewStatus === "pushed" ? (
              <>
                Pushed{publishedUrl ? <> to <a href={publishedUrl} target="_blank" rel="noreferrer" className="underline">{publishedUrl}</a></> : ""}. The decisions below are what went out.
              </>
            ) : (
              "Rejected. The page was not changed."
            )}
          </div>
        )}

        {pushBlocker && editable && (
          <div className="rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px]">
            <div className="font-medium mb-0.5">Push to site is unavailable for this page</div>
            <p className="m-0 text-ink-3 leading-relaxed">{pushBlocker}</p>
          </div>
        )}

        {issues.length > 0 && (
          <div className="rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px]">
            <div className="font-medium mb-1">{plural(issues.length, "check")} flagged before review</div>
            <ul className="m-0 pl-4 space-y-0.5 text-ink-2">
              {issues.map((i) => (
                <li key={i.code} className={i.severity === "error" ? "text-err-ink" : ""}>{i.message}</li>
              ))}
            </ul>
          </div>
        )}

        <details className="rounded-[9px] border border-line bg-panel px-4 py-3 text-[13px]">
          <summary className="cursor-pointer font-medium">Why this page, and the brief the rewrite followed</summary>
          <div className="mt-2 text-ink-3">{describeEvidence(evidence).join(" · ") || "No measurements recorded."}</div>
          {brief && <pre className="mt-2 whitespace-pre-wrap font-mono text-[12px] text-ink-2 m-0">{brief}</pre>}
        </details>

        {/* Title and meta */}
        {(titleChanged || metaChanged) && (
          <div className="rounded-[9px] border border-line overflow-hidden">
            {titleChanged && (
              <FieldRow
                label="Title"
                before={before.title}
                after={after.title}
                decision={fields.title}
                editable={editable}
                onDecide={(d) => setFields((f) => ({ ...f, title: d }))}
              />
            )}
            {metaChanged && (
              <FieldRow
                label="Meta description"
                before={before.metaDescription}
                after={after.metaDescription}
                decision={fields.metaDescription}
                editable={editable}
                onDecide={(d) => setFields((f) => ({ ...f, metaDescription: d }))}
              />
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-[12.5px] text-ink-3">
          <span>
            {plural(summary.total, "changed block")}
            {unchangedCount > 0 && `, ${unchangedCount} unchanged`}
          </span>
          {unchangedCount > 0 && (
            <button type="button" className="underline decoration-line underline-offset-2 hover:text-ink" onClick={() => setShowUnchanged((v) => !v)}>
              {showUnchanged ? "Hide unchanged" : "Show unchanged"}
            </button>
          )}
        </div>

        <div className="space-y-3">
          {visibleHunks.map((h) => {
            const d = decisions[h.id];
            const isEdited = typeof edited[h.id] === "string";
            return (
              <div
                key={h.id}
                className={cn(
                  "rounded-[9px] border overflow-hidden",
                  h.kind === "unchanged" ? "border-line-soft opacity-80" : "border-line",
                  d === "accepted" && "border-ok",
                  d === "rejected" && "border-line-soft",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-1.5 bg-panel border-b border-line-soft text-[11.5px]">
                  <span className="font-mono uppercase tracking-[0.06em] text-ink-3">{h.kind}</span>
                  {isEdited && <span className="text-accent-ink">edited by you</span>}
                  {d && <span className={d === "accepted" ? "text-ok-ink" : "text-ink-3"}>{d === "accepted" ? "kept" : "rejected"}</span>}
                  {editable && h.kind !== "unchanged" && (
                    <div className="ml-auto flex gap-1">
                      <KeepRejectButtons decision={d} onDecide={(dec) => decide(h.id, dec)} />
                      <Button size="sm" variant="ghost" onClick={() => setEditing(editing === h.id ? null : h.id)}>
                        <Icons.edit size={12} /> Edit
                      </Button>
                    </div>
                  )}
                </div>
                {editing === h.id && editable ? (
                  <div className="p-3">
                    <textarea
                      defaultValue={edited[h.id] ?? h.after ?? h.before ?? ""}
                      rows={8}
                      className="w-full bg-bg border border-line rounded-[6px] px-2.5 py-2 text-[12px] leading-relaxed font-mono"
                      onBlur={(e) => {
                        setEdited((prev) => ({ ...prev, [h.id]: e.target.value }));
                        decide(h.id, "accepted");
                      }}
                    />
                    <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3">
                      <span>Raw HTML for this block. Saving marks it kept with your text.</span>
                      <button
                        type="button"
                        className="underline"
                        onClick={() => {
                          setEdited((prev) => {
                            const next = { ...prev };
                            delete next[h.id];
                            return next;
                          });
                          setEditing(null);
                        }}
                      >
                        Discard my edit
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={cn("grid", h.kind === "changed" ? "md:grid-cols-2" : "grid-cols-1")}>
                    {h.kind !== "added" && (
                      <div className={cn("p-3 prose-block text-[13.5px] leading-relaxed", h.kind === "changed" && "md:border-r border-line-soft", h.kind === "removed" && "bg-err-soft/40")}>
                        {h.kind === "changed" && <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-4 mb-1">Before</div>}
                        <div dangerouslySetInnerHTML={{ __html: sanitizeHunkHtml(h.before ?? "") }} />
                      </div>
                    )}
                    {h.kind !== "removed" && h.kind !== "unchanged" && (
                      <div className={cn("p-3 prose-block text-[13.5px] leading-relaxed", h.kind === "added" && "bg-ok-soft/40")}>
                        {h.kind === "changed" && <div className="text-[10.5px] uppercase tracking-[0.06em] text-ink-4 mb-1">After</div>}
                        <div dangerouslySetInnerHTML={{ __html: sanitizeHunkHtml(isEdited ? edited[h.id] : h.after ?? "") }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Dialog
        open={confirmPush}
        onOpenChange={setConfirmPush}
        title="Push to site"
        description={`This updates the live post in ${destinationLabel ?? "your CMS"} with ${summary.kept} of ${plural(summary.total, "change")}. Blocks you rejected or left undecided stay as they are today. This is the only step that writes to your site.`}
      >
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirmPush(false)} disabled={pending}>Cancel</Button>
          <Button variant="accent" onClick={push} disabled={pending}>
            {pending ? "Pushing…" : `Push ${summary.kept} ${summary.kept === 1 ? "change" : "changes"}`}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function FieldRow({
  label,
  before,
  after,
  decision,
  editable,
  onDecide,
}: {
  label: string;
  before: string | null;
  after: string | null;
  decision?: HunkDecision;
  editable: boolean;
  onDecide: (d: HunkDecision) => void;
}) {
  return (
    <div className="grid md:grid-cols-[120px_1fr_1fr_auto] gap-3 items-start px-3 py-2.5 text-[13px] border-b border-line-soft last:border-b-0">
      <div className="text-[11px] uppercase tracking-[0.06em] text-ink-3 pt-0.5">{label}</div>
      <div className="text-ink-3">{before || <em>none</em>}</div>
      <div className={cn(decision === "accepted" && "text-ok-ink")}>{after || <em>none</em>}</div>
      {editable ? (
        <div className="flex gap-1">
          <Button size="sm" variant={decision === "accepted" ? "primary" : "ghost"} onClick={() => onDecide("accepted")}>Keep</Button>
          <Button size="sm" variant={decision === "rejected" ? "primary" : "ghost"} onClick={() => onDecide("rejected")}>Reject</Button>
        </div>
      ) : (
        <span className="text-[11.5px] text-ink-3">{decision === "accepted" ? "kept" : "original"}</span>
      )}
    </div>
  );
}

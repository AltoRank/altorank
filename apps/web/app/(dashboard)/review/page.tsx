import type { Metadata } from "next";
import Link from "next/link";
import { getArticles } from "@/lib/queries/articles";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { PageHead, DotSep, StatStrip } from "@/components/ui";
import { Card } from "@/components/ui/card";
import { ReviewQueueActions, VerdictPill } from "./review-actions";
import type { Article, Workspace } from "@/lib/types";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Review queue" };

/**
 * Everything waiting for a human, in one place, with the three numbers that
 * decide the click: the fact-check verdict, the SEO score and the AEO score.
 *
 * The autopilot tools' happiest customers are the ones who "go through and
 * check everything" before it ships, and their unhappiest are the ones who
 * trusted the default (altorank-notes, 2026-09-02-what-the-reviews-say.md).
 * The gate is only an advantage if it is fast. So: open the draft in one
 * click, approve from the row when the verdict is clean, and approve every
 * clean draft at once when there are many. Nothing here publishes; approval
 * is the sign-off, publishing is still its own step.
 */
export default async function ReviewQueuePage() {
  const [articles, workspaces] = await Promise.all([
    getArticles(undefined, "review"),
    getWorkspaces(),
  ]);
  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));

  const clean = articles.filter((a) => a.fact_check_verdict === "clean");
  const flagged = articles.filter((a) => a.fact_check_verdict === "review");
  const risky = articles.filter((a) => a.fact_check_verdict === "high_risk");
  const unchecked = articles.filter((a) => !a.fact_check_verdict);

  return (
    <>
      <PageHead
        title="Review queue"
        subtitle={
          <>
            <span>{plural(articles.length, "draft")} waiting</span>
            <DotSep />
            <span>across {plural(new Set(articles.map((a) => a.workspace_id)).size, "workspace")}</span>
          </>
        }
        actions={<ReviewQueueActions cleanIds={clean.map((a) => a.id)} />}
      />

      <StatStrip
        stats={[
          { label: "Clean fact check", value: clean.length, delta: clean.length ? "approve in one click" : "none yet", deltaType: clean.length ? "pos" : undefined },
          { label: "Claims to check", value: flagged.length, delta: flagged.length ? "open before approving" : "none" },
          { label: "High risk", value: risky.length, delta: risky.length ? "unsourced figures found" : "none", deltaType: risky.length ? "neg" : undefined },
          { label: "Not checked", value: unchecked.length, delta: unchecked.length ? "generated before fact checks" : "" },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {articles.length === 0 ? (
          <Card>
            <div className="px-6 py-14 text-center text-[13.5px] text-ink-3">
              Nothing is waiting for you. Drafts land here the moment they finish generating, and
              nothing leaves without your approval.
            </div>
          </Card>
        ) : (
          <Card>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Draft", "Workspace", "Fact check", "SEO", "AEO", "Words", "Ready since", ""].map((h, i) => (
                    <th
                      key={h || i}
                      className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["SEO", "AEO", "Words", "Ready since"].includes(h) ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {articles.map((a: Article) => {
                  const since = a.updated_at
                    ? new Date(a.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : "—";
                  return (
                    <tr key={a.id} className="hover:[&>td]:bg-panel">
                      <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                        <Link href={`/content/${a.id}`} className="block truncate font-medium hover:underline">
                          {a.title}
                        </Link>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-3">{a.keyword}</div>
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-xs text-ink-2">{wsMap.get(a.workspace_id)?.name ?? "—"}</td>
                      <td className="px-3.5 py-3 border-b border-line-soft">
                        <VerdictPill verdict={a.fact_check_verdict} count={a.fact_checks?.counts?.total ?? null} />
                      </td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.seo_score > 0 ? a.seo_score : "—"}</td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.aeo_score ?? "—"}</td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.word_count ? a.word_count.toLocaleString() : "—"}</td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{since}</td>
                      <td className="px-3.5 py-3 border-b border-line-soft text-right">
                        <ReviewQueueActions rowId={a.id} verdict={a.fact_check_verdict} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </>
  );
}

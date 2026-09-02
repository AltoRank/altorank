import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getKeywords } from "@/lib/queries/keywords";
import { PageHead, StatusPill, Avatar, Chip, Card, StatStrip } from "@/components/ui";
import { KeywordActions } from "@/components/dashboard/keyword-actions";
import { KeywordFilters } from "@/components/dashboard/keyword-filters";
import { KeywordPlanButton } from "@/components/dashboard/keyword-plan-button";
import type { Workspace } from "@/lib/types";
import { getScopedWorkspaceId } from "@/lib/workspace-scope";

export const metadata: Metadata = { title: "Keywords" };

type Props = {
  searchParams: Promise<{ status?: string; intent?: string; q?: string }>;
};

/**
 * Case-insensitive substring match across the fields a person would actually
 * type. Applied on the server, next to the data, so the filter bar only has to
 * own the URL.
 */
function matchesQuery(fields: (string | null | undefined)[], q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

export default async function KeywordsPage({ searchParams }: Props) {
  // Every section is about one site unless the switcher says otherwise.
  const scopeId = await getScopedWorkspaceId();
  const params = await searchParams;

  const [workspaces, keywords] = await Promise.all([
    getWorkspaces(),
    getKeywords(scopeId ?? undefined, params.status, params.intent),
  ]);

  const wsMap = new Map<string, Workspace>(workspaces.map((w) => [w.id, w]));
  const shown = keywords.filter((k) => matchesQuery([k.term], params.q ?? ""));

  const shippedCount = keywords.filter((k) => k.status === "shipped").length;
  const newCount = keywords.filter((k) => k.status === "new").length;
  const scored = keywords
    .map((k) => k.difficulty)
    .filter((d): d is number => typeof d === "number");

  return (
    <>
      <PageHead
        title="Keywords"
        subtitle={<span>Across all workspaces</span>}
        actions={<KeywordActions workspaces={workspaces} keywords={keywords} />}
      />

      <StatStrip
        stats={[
          { label: "Tracked", value: keywords.length.toLocaleString(), delta: `${newCount} new`, deltaType: newCount > 0 ? "pos" : undefined },
          { label: "Shipped", value: shippedCount.toLocaleString(), delta: "articles live" },
          // Averaged over keywords that actually have a difficulty. Counting
          // unknowns as 0 dragged the average toward "easy" in proportion to
          // how little we knew.
          { label: "Avg difficulty", value: scored.length > 0 ? Math.round(scored.reduce((s, d) => s + d, 0) / scored.length) : "—" },
          {
            label: "Unscored",
            value: String(keywords.length - scored.length),
            delta: scored.length === keywords.length ? "all have difficulty" : "no difficulty reading",
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <KeywordFilters />

        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Keyword", "Workspace", "Intent", "Volume", "Difficulty", "Status", ""].map((h, i) => (
                  <th key={h || i} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${h === "Volume" ? "text-right" : "text-left"}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const w = wsMap.get(k.workspace_id);
                const known = typeof k.difficulty === "number";
                const diffColor = !known
                  ? "var(--line)"
                  : k.difficulty! < 25 ? "var(--ok)" : k.difficulty! < 50 ? "var(--warn)" : "var(--err)";
                return (
                  <tr key={k.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <span className="font-mono text-[13px] text-ink font-medium">{k.term}</span>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      {w && (
                        <span className="inline-flex items-center gap-2">
                          <Avatar initials={w.initials} color={w.color} size="sm" />
                          {w.name}
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <Chip label={k.intent} soft />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {k.volume.toLocaleString()}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-[60px] h-[5px] bg-panel-2 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: known ? `${k.difficulty}%` : "0%", background: diffColor }} />
                        </div>
                        <span
                          className={`font-mono text-[11px] w-5 text-right ${known ? "" : "text-ink-4"}`}
                          title={known ? undefined : "No difficulty data from the keyword provider"}
                        >
                          {known ? k.difficulty : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <StatusPill status={k.status} />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <KeywordPlanButton keywordId={k.id} currentStatus={k.status} />
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3.5 py-8 text-center text-ink-3">No keywords yet. Click &quot;Find new keywords&quot; to get started.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

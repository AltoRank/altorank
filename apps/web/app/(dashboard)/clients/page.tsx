import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { PageHead, DotSep, StatusPill, Avatar, Icons, Chip, Card } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { ClientActions } from "@/components/dashboard/client-actions";
import { ClientFilters } from "@/components/dashboard/client-filters";
import { ClientRow } from "@/components/dashboard/client-row";

export const metadata: Metadata = { title: "Clients" };

const STATUS_LABEL: Record<string, string> = { on: "Publishing", review: "Review", paused: "Paused", setup: "Setup" };

type Props = {
  searchParams: Promise<{ status?: string }>;
};

export default async function ClientsPage({ searchParams }: Props) {
  const params = await searchParams;

  const [workspaces, allArticles] = await Promise.all([
    getWorkspaces(params.status),
    getArticles(),
  ]);

  const wsCounts = new Map<string, { total: number; live: number }>();
  for (const a of allArticles) {
    const c = wsCounts.get(a.workspace_id) ?? { total: 0, live: 0 };
    c.total++;
    if (a.status === "live") c.live++;
    wsCounts.set(a.workspace_id, c);
  }

  const totalLive = allArticles.filter((a) => a.status === "live").length;

  return (
    <>
      <PageHead
        title="Clients"
        eyebrow={
          <>
            <span>Agency</span>
            <StatusPill status="on" label={`${workspaces.length} workspaces`} />
          </>
        }
        subtitle={
          <>
            <span>{workspaces.length} workspaces</span>
            <DotSep />
            <span>{totalLive} articles published</span>
          </>
        }
        actions={<ClientActions />}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <ClientFilters />

        <Card>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Client</th>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Status</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Articles</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Traffic /mo</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">DR</th>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Plan</th>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel" />
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => {
                const counts = wsCounts.get(w.id) ?? { total: 0, live: 0 };
                return (
                  <ClientRow key={w.id} href={`/clients/${w.id}`}>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <div className="flex items-center gap-2.5">
                        <Avatar initials={w.initials} color={w.color} size="lg" />
                        <div>
                          <div className="font-semibold">{w.name}</div>
                          <div className="font-mono text-[11px] text-ink-3">{w.domain}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <StatusPill status={w.status} label={STATUS_LABEL[w.status]} />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {counts.live} / {counts.total}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {w.traffic}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {w.dr}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <Chip label={w.plan ?? "—"} soft />
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <IconButton ghost disabled><Icons.more size={14} /></IconButton>
                    </td>
                  </ClientRow>
                );
              })}
              {workspaces.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3.5 py-8 text-center text-ink-3">No clients yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

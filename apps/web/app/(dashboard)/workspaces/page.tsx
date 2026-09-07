import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getArticles } from "@/lib/queries/articles";
import { PageHead, StatusPill, Avatar, Chip, Card } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { ClientActions } from "@/components/dashboard/client-actions";
import { requireAuth } from "@/lib/auth/require-auth";
import { createClient } from "@/lib/supabase/server";
import { getWorkspaceAllowance } from "@/lib/billing/workspaces";
import { canAddWorkspace } from "@/lib/team/access";
import { ClientFilters } from "@/components/dashboard/client-filters";
import { ClientRow } from "@/components/dashboard/client-row";
import { PauseSiteControl } from "@/components/dashboard/paused-banner";
import { plural } from "@/lib/utils";

export const metadata: Metadata = { title: "Workspaces" };

const STATUS_LABEL: Record<string, string> = { on: "Publishing", review: "Review", paused: "Paused", setup: "Setup" };

type Props = {
  searchParams: Promise<{ status?: string; q?: string }>;
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

export default async function ClientsPage({ searchParams }: Props) {
  const params = await searchParams;

  const [workspaces, allArticles] = await Promise.all([
    getWorkspaces(params.status),
    getArticles(),
  ]);
  const { agencyId, user, role } = await requireAuth();
  const allowance = await getWorkspaceAllowance(await createClient(), agencyId, user.email);

  const wsCounts = new Map<string, { total: number; live: number }>();
  for (const a of allArticles) {
    const c = wsCounts.get(a.workspace_id) ?? { total: 0, live: 0 };
    c.total++;
    if (a.status === "live") c.live++;
    wsCounts.set(a.workspace_id, c);
  }

  const shown = workspaces.filter((w) => matchesQuery([w.name, w.domain], params.q ?? ""));

  const totalLive = allArticles.filter((a) => a.status === "live").length;

  return (
    <>
      <PageHead
        title="Workspaces"
        subtitle={<><StatusPill status="on" label={plural(workspaces.length, "workspace")} /><span>{plural(totalLive, "article")} published</span></>}
        actions={
          <ClientActions
            allowance={{ limit: allowance.limit, remaining: allowance.remaining, used: allowance.used, noPlan: allowance.reason === "no-plan" }}
            canAdd={canAddWorkspace(role)}
          />
        }
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        <ClientFilters />

        <Card flush>
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Workspace</th>
                <th className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Status</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Articles</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Traffic /mo</th>
                <th className="text-right font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">Authority</th>
                {/* Pause/Resume. The column has no visible heading - the
                    control names itself and a caption over one button is
                    noise - but it is not nameless: screen readers get one. */}
                <th className="w-px px-3.5 py-2.5 border-b border-line bg-panel">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((w) => {
                const counts = wsCounts.get(w.id) ?? { total: 0, live: 0 };
                return (
                  <ClientRow key={w.id} href={`/workspaces/${w.id}`}>
                    <td className="px-3.5 py-3 border-b border-line-soft">
                      <div className="flex items-center gap-2.5">
                        <Avatar initials={w.initials} color={w.color} size="lg" />
                        <div className="min-w-0">
                          {/* A workspace's name defaults to its domain, so
                              until an account renames one this printed the
                              same string twice in two typefaces. */}
                          <div className="font-semibold truncate">{w.name}</div>
                          {w.domain && w.domain !== w.name && (
                            <div className="font-mono text-[11px] text-ink-3 truncate">{w.domain}</div>
                          )}
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
                      {w.traffic?.toLocaleString() ?? "—"}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {typeof w.dr === "number" ? w.dr : "—"}
                    </td>
                    {/* Pausing is workspace management, so it lives on the
                        roster beside the status it changes rather than under
                        the sidebar switcher, where it used to sit on every
                        screen in the app. The Status column above is what says
                        a workspace is paused; this is only the way in and out.
                        Renders nothing for a workspace still in setup - there
                        is nothing running to stop. */}
                    <td className="px-3.5 py-3 border-b border-line-soft text-right whitespace-nowrap">
                      <PauseSiteControl workspaceId={w.id} name={w.name} status={w.status} />
                    </td>
                  </ClientRow>
                );
              })}
              {workspaces.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3.5 py-10 text-center text-ink-3">
                    <span className="inline-block max-w-[56ch] leading-[1.6]">
                      No sites yet. Add workspace above takes a name and a domain, and the first analysis starts on its
                      own: agent readiness, a crawl of the site&rsquo;s pages, PageSpeed, and the keywords it already
                      ranks for. Everything else in the app is about one of these.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}

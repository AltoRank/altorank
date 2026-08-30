import type { Metadata } from "next";
import { getWorkspaces } from "@/lib/queries/workspaces";
import { getGeoPrompts, getLatestGeoResults, summariseRows } from "@/lib/queries/geo";
import { deriveGeoActions } from "@/lib/geo/actions";
import { PageHead, StatusPill, Card, StatStrip, Chip, DotSep } from "@/components/ui";
import type { AiEngine } from "@/lib/geo/ai-visibility";

export const metadata: Metadata = { title: "AI visibility" };

const ENGINE_LABEL: Record<AiEngine, string> = {
  chat_gpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

export default async function GeoPage() {
  const [workspaces, prompts, rows] = await Promise.all([
    getWorkspaces(),
    getGeoPrompts(),
    getLatestGeoResults(),
  ]);

  const summary = summariseRows(rows);
  const trackedDomain = workspaces.find(
    (w) => (w as { geo_tracking?: boolean }).geo_tracking,
  )?.domain;
  const actions = rows.length
    ? deriveGeoActions({ rows, brandDomain: trackedDomain ?? "" })
    : [];
  const tracked = workspaces.filter((w) => (w as { geo_tracking?: boolean }).geo_tracking);
  const lastChecked = rows[0]?.checked_at
    ? new Date(rows[0].checked_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  // Per-engine breakdown: an answer engine you are invisible in is a different
  // problem from one you are merely low in, and the fix differs too.
  const byEngine = new Map<AiEngine, { total: number; mentioned: number; cited: number }>();
  for (const r of rows) {
    if (r.error) continue;
    const e = byEngine.get(r.engine) ?? { total: 0, mentioned: 0, cited: 0 };
    e.total += 1;
    if (r.mentioned) e.mentioned += 1;
    if (r.cited) e.cited += 1;
    byEngine.set(r.engine, e);
  }

  return (
    <>
      <PageHead
        title="AI visibility"
        eyebrow={
          <>
            <span>Generative engine optimisation</span>
            <StatusPill
              status={tracked.length ? "on" : "setup"}
              label={tracked.length ? `${tracked.length} tracked` : "Not enabled"}
            />
            {lastChecked && (
              <>
                <DotSep />
                <span>Last measured {lastChecked}</span>
              </>
            )}
          </>
        }
        subtitle={
          <span>
            Whether ChatGPT, Claude, Gemini and Perplexity name this brand when
            someone asks the buying question, and which domains they name instead.
          </span>
        }
      />

      <StatStrip
        stats={[
          {
            label: "Mention rate",
            // Dashes, not zeroes, when nothing has been measured. A 0% that
            // means "never ran" reads as "you are invisible", which is a
            // different and much worse claim.
            value: summary.probesRun ? `${summary.mentionRate}%` : "—",
            delta: summary.probesRun ? `${summary.probesRun} answers` : "not measured",
          },
          {
            label: "Citation rate",
            value: summary.probesRun ? `${summary.citationRate}%` : "—",
            delta: summary.probesRun ? "own domain cited" : "not measured",
          },
          {
            label: "Prompts tracked",
            value: prompts.length ? String(prompts.filter((p) => p.enabled).length) : "—",
            delta: prompts.length ? "buyer questions" : "none defined",
          },
          {
            label: "Cost last run",
            value: summary.probesRun ? `$${summary.totalCostUsd.toFixed(2)}` : "—",
            delta: summary.probesFailed ? `${summary.probesFailed} probes failed` : "all probes ok",
          },
        ]}
      />

      <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-5">
        {actions.length > 0 && (
          <Card>
            <div className="px-5 pt-4 pb-1 font-semibold text-sm">What to do about it</div>
            <div className="px-5 pb-3 text-[12.5px] text-ink-3">
              Derived from the answers above, ranked. Each one names the
              measurement it came from.
            </div>
            <div className="px-5 pb-5 flex flex-col gap-2.5">
              {actions.map((a, i) => (
                <div key={i} className="border border-line rounded-[7px] px-3.5 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-[13px]">{a.title}</span>
                    {a.automatable && <Chip label="AltoRank can do this" soft />}
                  </div>
                  <p className="text-[12.5px] text-ink-2 leading-[1.6]">{a.detail}</p>
                  <div className="text-[11.5px] text-ink-3 font-mono mt-1.5">{a.evidence}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {!prompts.length && (
          <Card>
            <div className="p-5">
              <div className="font-semibold text-sm mb-1.5">No prompts defined yet</div>
              <p className="text-[13px] text-ink-2 leading-[1.6] max-w-[62ch]">
                AI visibility is measured against a fixed set of questions a buyer
                would actually ask. The prompt set is the measurement, so it is
                chosen deliberately rather than generated: changing it changes the
                number and breaks the trend line. Add prompts for a workspace and
                enable <code className="font-mono text-[12px]">geo_tracking</code>{" "}
                to start measuring.
              </p>
            </div>
          </Card>
        )}

        {byEngine.size > 0 && (
          <Card>
            <div className="px-5 pt-4 pb-2 font-semibold text-sm">By answer engine</div>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Engine", "Answers", "Mentioned", "Cited"].map((h) => (
                    <th
                      key={h}
                      className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${
                        h === "Engine" ? "text-left" : "text-right"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...byEngine.entries()].map(([engine, e]) => (
                  <tr key={engine} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft font-medium">
                      {ENGINE_LABEL[engine]}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {e.total}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs">
                      {Math.round((e.mentioned / e.total) * 100)}%
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs">
                      {Math.round((e.cited / e.total) * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {summary.topCompetitors.length > 0 && (
          <Card>
            <div className="px-5 pt-4 pb-1 font-semibold text-sm">
              Who gets cited instead
            </div>
            <div className="px-5 pb-3 text-[12.5px] text-ink-3">
              Domains the answer engines cited across these prompts. This is the
              target list: these pages are what an AI reads before answering.
            </div>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Domain", "Citations", "Share of voice"].map((h) => (
                    <th
                      key={h}
                      className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${
                        h === "Domain" ? "text-left" : "text-right"
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.topCompetitors.map((c) => (
                  <tr key={c.domain} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-3 border-b border-line-soft font-mono text-[12.5px]">
                      {c.domain}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {c.citations}
                    </td>
                    <td className="px-3.5 py-3 border-b border-line-soft text-right">
                      <div className="flex items-center gap-2 justify-end">
                        <div className="w-[60px] h-[5px] bg-panel-2 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.min(100, c.shareOfVoice * 3)}%` }}
                          />
                        </div>
                        <span className="font-mono text-[11px] w-10 text-right">
                          {c.shareOfVoice}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {prompts.length > 0 && (
          <Card>
            <div className="px-5 pt-4 pb-1 font-semibold text-sm">The prompt set</div>
            <div className="px-5 pb-3 text-[12.5px] text-ink-3">
              Every measurement above is the answer to one of these, asked of each
              engine.
            </div>
            <div className="px-5 pb-5 flex flex-col gap-2">
              {prompts.map((p) => {
                const forPrompt = rows.filter((r) => r.prompt === p.prompt && !r.error);
                const hits = forPrompt.filter((r) => r.mentioned).length;
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 border border-line rounded-[7px] px-3 py-2.5"
                  >
                    <span className="flex-1 text-[13px]">{p.prompt}</span>
                    {!p.enabled && <Chip label="disabled" soft />}
                    <span className="font-mono text-[11.5px] text-ink-3">
                      {forPrompt.length ? `named in ${hits}/${forPrompt.length}` : "not measured"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

"use client";

import { useState } from "react";
import { TabRow, Icons, StatusPill, Avatar, Chip, Card, SearchInput, StatStrip } from "@/components/ui";
import { IconButton } from "@/components/ui/button";
import { SetupWizard } from "@/components/dashboard/setup-wizard";
import { PublishingCadenceForm } from "@/components/dashboard/publishing-cadence-form";
import { LocaleSelector } from "@/components/dashboard/locale-selector";
import { FirstDraftLive } from "./first-draft-live";
import type { Article, Keyword, CalendarEntry, Backlink, VoiceProfile, Workspace, PublishingCadence } from "@/lib/types";

type ClientTabsProps = {
  workspace: Workspace;
  articles: Article[];
  keywords: Keyword[];
  calendar: CalendarEntry[];
  backlinks: Backlink[];
  voice: VoiceProfile | null;
  cadence: PublishingCadence | null;
  /** Server clock at render; see FirstDraftLive. */
  now: number;
};

const TABS = [
  { id: "overview", label: "Overview", icon: <Icons.dashboard size={14} /> },
  { id: "articles", label: "Articles", icon: <Icons.articles size={14} /> },
  { id: "keywords", label: "Keywords", icon: <Icons.keywords size={14} /> },
  { id: "calendar", label: "Calendar", icon: <Icons.calendar size={14} /> },
  { id: "voice", label: "Brand Voice", icon: <Icons.voice size={14} /> },
  { id: "backlinks", label: "Backlinks", icon: <Icons.backlinks size={14} /> },
  { id: "settings", label: "Settings", icon: <Icons.settings size={14} /> },
];

export function ClientTabs({ workspace, articles, keywords, calendar, backlinks, voice, cadence, now }: ClientTabsProps) {
  const [activeTab, setActiveTab] = useState("overview");

  const tabs = TABS.map((t) => {
    let count: number | undefined;
    if (t.id === "articles") count = articles.length;
    if (t.id === "keywords") count = keywords.length;
    if (t.id === "backlinks") count = backlinks.length;
    return { ...t, count };
  });

  return (
    <>
      <TabRow tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
      <div className="flex-1 overflow-y-auto px-8 py-6 scroll">
        {activeTab === "overview" && <OverviewTab workspace={workspace} articles={articles} keywords={keywords} backlinks={backlinks} voice={voice} now={now} />}
        {activeTab === "articles" && <ArticlesTab articles={articles} />}
        {activeTab === "keywords" && <KeywordsTab keywords={keywords} />}
        {activeTab === "calendar" && <CalendarTab calendar={calendar} />}
        {activeTab === "voice" && <VoiceTab voice={voice} />}
        {activeTab === "backlinks" && <BacklinksTab backlinks={backlinks} />}
        {activeTab === "settings" && <SettingsTab workspace={workspace} cadence={cadence} />}
      </div>
    </>
  );
}

/* ── Overview ────────────────────────────────────────── */

function OverviewTab({ workspace, articles, keywords, backlinks, voice, now }: {
  workspace: Workspace;
  articles: Article[];
  keywords: Keyword[];
  backlinks: Backlink[];
  voice: VoiceProfile | null;
  now: number;
}) {
  if (workspace.status === "setup") {
    return <SetupWizard workspace={workspace} voice={voice} keywords={keywords} articleCount={articles.length} />;
  }

  const liveCount = articles.filter((a) => a.status === "live").length;
  const recentArticles = articles.slice(0, 5);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Articles", value: articles.length, sub: `${liveCount} live` },
          { label: "Keywords", value: keywords.length, sub: "tracked" },
          { label: "Backlinks", value: backlinks.length, sub: "discovered" },
          {
            label: "Brand Voice",
            value: voice?.trained ? "Trained" : "Not set",
            // Counted from the stored sample. This read `rules.wordCount`,
            // which does not exist on VoiceRules and is never returned by the
            // analyzer, so every trained profile reported "0 words analyzed".
            // Same defect as the one fixed on /voice; it lived in two places.
            sub: voice?.trained
              ? `${(voice.sample_text ?? "").split(/\s+/).filter(Boolean).length.toLocaleString()} words analyzed`
              : "needs training",
          },
        ].map((s) => (
          <Card key={s.label} className="p-4" flush>
            <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] font-medium">{s.label}</div>
            <div className="text-2xl font-semibold font-mono mt-1">{s.value}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">{s.sub}</div>
          </Card>
        ))}
      </div>

      {/* Owns all three of "writing now", "nothing yet" and "here is why it
          chose that", because they are mutually exclusive and the condition
          this replaced got it wrong: a workspace mid-draft already has an
          article row, so this card disappeared the moment drafting started. */}
      <FirstDraftLive
        articles={articles}
        keywordCount={keywords.length}
        autoGenerate={workspace.auto_generate}
        now={now}
      />

      {recentArticles.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-ink-2 mb-3">Recent articles</h3>
          <Card flush>
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {recentArticles.map((a) => (
                  <tr key={a.id} className="hover:[&>td]:bg-panel">
                    <td className="px-3.5 py-2.5 border-b border-line-soft">
                      <div className="font-medium truncate">{a.title}</div>
                    </td>
                    <td className="px-3.5 py-2.5 border-b border-line-soft font-mono text-xs text-ink-2">{a.keyword}</td>
                    <td className="px-3.5 py-2.5 border-b border-line-soft"><StatusPill status={a.status} /></td>
                    <td className="px-3.5 py-2.5 border-b border-line-soft text-right font-mono text-xs text-ink-2">
                      {a.seo_score || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ── Articles ────────────────────────────────────────── */

function ArticlesTab({ articles }: { articles: Article[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = articles.filter((a) => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search && !a.title.toLowerCase().includes(search.toLowerCase()) && !a.keyword.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const statusChips = [
    { label: "All", value: null },
    { label: "Live", value: "live" },
    { label: "Review", value: "review" },
    { label: "Drafting", value: "drafting" },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SearchInput placeholder="Search articles…" className="flex-1 max-w-[320px]" value={search} onChange={setSearch} />
        {statusChips.map((c) => (
          <Chip key={c.label} label={c.label} active={statusFilter === c.value} onClick={() => setStatusFilter(c.value)} />
        ))}
      </div>
      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Article", "Keyword", "Status", "Score", "Vol /mo", "Position", "Updated"].map((h) => (
                <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${["Score", "Vol /mo", "Position", "Updated"].includes(h) ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const dateStr = a.updated_at ? new Date(a.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
              return (
                <tr key={a.id} className="hover:[&>td]:bg-panel">
                  <td className="px-3.5 py-3 border-b border-line-soft" style={{ maxWidth: 0 }}>
                    <div className="truncate font-medium">{a.title}</div>
                    <div className="text-[11px] text-ink-3 mt-0.5">{a.word_count ? `${a.word_count.toLocaleString()} words` : "Draft"}</div>
                  </td>
                  <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">{a.keyword}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={a.status} /></td>
                  <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.seo_score || "—"}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{typeof a.volume === "number" ? a.volume.toLocaleString() : "—"}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{a.position ? `#${a.position}` : "—"}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{dateStr}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-3.5 py-8 text-center text-ink-3">{articles.length === 0 ? "No articles yet" : "No matching articles"}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ── Keywords ────────────────────────────────────────── */

function KeywordsTab({ keywords }: { keywords: Keyword[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = keywords.filter((k) => {
    if (statusFilter && k.status !== statusFilter) return false;
    if (search && !k.term.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const statusChips = [
    { label: "All", value: null },
    { label: "New", value: "new" },
    { label: "Planned", value: "planned" },
    { label: "Shipped", value: "shipped" },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SearchInput placeholder="Search keywords…" className="flex-1 max-w-[320px]" value={search} onChange={setSearch} />
        {statusChips.map((c) => (
          <Chip key={c.label} label={c.label} active={statusFilter === c.value} onClick={() => setStatusFilter(c.value)} />
        ))}
      </div>
      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Keyword", "Intent", "Volume", "Difficulty", "Status"].map((h) => (
                <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${h === "Volume" ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((k) => {
              // Unknown difficulty renders neutral and blank, never a green 0.
              const known = typeof k.difficulty === "number";
              const diffColor = !known
                ? "var(--line)"
                : k.difficulty! < 25 ? "var(--ok)" : k.difficulty! < 50 ? "var(--warn)" : "var(--err)";
              return (
                <tr key={k.id} className="hover:[&>td]:bg-panel">
                  <td className="px-3.5 py-3 border-b border-line-soft font-mono text-[13px] font-medium">{k.term}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft"><Chip label={k.intent} soft /></td>
                  <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{k.volume.toLocaleString()}</td>
                  <td className="px-3.5 py-3 border-b border-line-soft">
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-[60px] h-[5px] bg-panel-2 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: known ? `${k.difficulty}%` : "0%", background: diffColor }} />
                      </div>
                      <span className={`font-mono text-[11px] w-5 text-right ${known ? "" : "text-ink-4"}`}>
                        {known ? k.difficulty : "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={k.status} /></td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-3.5 py-8 text-center text-ink-3">{keywords.length === 0 ? "No keywords yet" : "No matching keywords"}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ── Calendar ────────────────────────────────────────── */

function CalendarTab({ calendar }: { calendar: CalendarEntry[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = calendar.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    if (search && !c.keyword.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const statusChips = [
    { label: "All", value: null },
    { label: "Scheduled", value: "scheduled" },
    { label: "Done", value: "done" },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SearchInput placeholder="Search calendar…" className="flex-1 max-w-[320px]" value={search} onChange={setSearch} />
        {statusChips.map((c) => (
          <Chip key={c.label} label={c.label} active={statusFilter === c.value} onClick={() => setStatusFilter(c.value)} />
        ))}
      </div>
      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Keyword", "Date", "Status"].map((h) => (
                <th key={h} className="text-left font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.id} className="hover:[&>td]:bg-panel">
                <td className="px-3.5 py-3 border-b border-line-soft font-mono text-[13px] font-medium">{c.keyword}</td>
                <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2">
                  {new Date(c.scheduled_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </td>
                <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={c.status} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={3} className="px-3.5 py-8 text-center text-ink-3">{calendar.length === 0 ? "No calendar entries yet" : "No matching entries"}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ── Voice ───────────────────────────────────────────── */

function VoiceTab({ voice }: { voice: VoiceProfile | null }) {
  if (!voice) {
    return (
      <Card className="p-8 text-center" flush>
        <Icons.voice size={32} className="mx-auto text-ink-3 mb-3" />
        <div className="text-[13px] text-ink-2 font-medium mb-1">No voice profile</div>
        <div className="text-[12px] text-ink-3">A voice profile will be created automatically when a domain is configured, or you can train one manually.</div>
      </Card>
    );
  }

  const rules = voice.rules as { tags?: string[]; avgSentenceLength?: number; wordCount?: number; sentenceCount?: number };
  const sentences = voice.sample_text
    ? voice.sample_text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  // The trainer stores tone, vocabulary and patterns, not counts, so these
  // three read as "—" on every trained profile (seen on a fresh workspace,
  // 2026-09-02). The sample is right here; count it. Stored counts win when
  // a future trainer writes them.
  const wordCount = rules.wordCount ?? (voice.sample_text ? voice.sample_text.split(/\s+/).filter(Boolean).length : null);
  const sentenceCount = rules.sentenceCount ?? (sentences.length || null);
  const avgSentenceLength =
    rules.avgSentenceLength ?? (wordCount && sentenceCount ? Math.round(wordCount / sentenceCount) : null);

  return (
    <div className="space-y-4">
      <Card className="p-5" flush>
        <div className="flex items-center gap-2 mb-3">
          <StatusPill status={voice.trained ? "on" : "setup"} label={voice.trained ? "Trained" : "Untrained"} />
        </div>
        <div className="grid grid-cols-3 gap-4 text-[13px]">
          <div>
            <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-1">Words analyzed</div>
            <div className="font-mono font-semibold">{wordCount?.toLocaleString() ?? "—"}</div>
          </div>
          <div>
            <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-1">Sentences</div>
            <div className="font-mono font-semibold">{sentenceCount ?? "—"}</div>
          </div>
          <div>
            <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-1">Avg sentence length</div>
            <div className="font-mono font-semibold">{avgSentenceLength ?? "—"} words</div>
          </div>
        </div>
      </Card>
      {sentences.length > 0 && (
        <Card className="p-5" flush>
          <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-2">Extracted sentences</div>
          <div className="space-y-1.5">
            {sentences.slice(0, 5).map((s, i) => (
              <div key={i} className="text-[12px] text-ink-2 leading-[1.5] pl-2 border-l-2 border-accent/30">
                {s}.
              </div>
            ))}
            {sentences.length > 5 && (
              <div className="text-[11px] text-ink-3">+{sentences.length - 5} more sentences</div>
            )}
          </div>
        </Card>
      )}
      {rules.tags && rules.tags.length > 0 && (
        <Card className="p-5" flush>
          <div className="text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-2">Style tags</div>
          <div className="flex flex-wrap gap-2">
            {rules.tags.map((tag) => <Chip key={tag} label={tag} soft />)}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ── Backlinks ───────────────────────────────────────── */

function BacklinksTab({ backlinks }: { backlinks: Backlink[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = backlinks.filter((b) => {
    if (statusFilter && b.status !== statusFilter) return false;
    if (search && !b.source_domain.toLowerCase().includes(search.toLowerCase()) && !b.anchor_text.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const statusChips = [
    { label: "All", value: null },
    { label: "Live", value: "live" },
    { label: "Pending", value: "pending" },
    { label: "Lost", value: "lost" },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SearchInput placeholder="Search backlinks…" className="flex-1 max-w-[320px]" value={search} onChange={setSearch} />
        {statusChips.map((c) => (
          <Chip key={c.label} label={c.label} active={statusFilter === c.value} onClick={() => setStatusFilter(c.value)} />
        ))}
      </div>
      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Source", "DR", "Anchor", "Target", "Status"].map((h) => (
                <th key={h} className={`font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel ${h === "DR" ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => (
              <tr key={b.id} className="hover:[&>td]:bg-panel">
                <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs">{b.source_domain}</td>
                <td className="px-3.5 py-3 border-b border-line-soft text-right font-mono text-xs text-ink-2">{b.source_dr}</td>
                <td className="px-3.5 py-3 border-b border-line-soft text-xs text-ink-2">{b.anchor_text}</td>
                <td className="px-3.5 py-3 border-b border-line-soft font-mono text-xs text-ink-2 truncate" style={{ maxWidth: 200 }}>{b.target_url}</td>
                <td className="px-3.5 py-3 border-b border-line-soft"><StatusPill status={b.status} /></td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-3.5 py-8 text-center text-ink-3">{backlinks.length === 0 ? "No backlinks discovered yet" : "No matching backlinks"}</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ── Settings ────────────────────────────────────────── */

function SettingsTab({ workspace, cadence }: { workspace: Workspace; cadence: PublishingCadence | null }) {
  return (
    <div className="max-w-lg space-y-4">
      <Card className="p-5" flush>
        <h3 className="text-[13px] font-medium mb-4">Workspace settings</h3>
        <div className="space-y-3 text-[13px]">
          {[
            { label: "Name", value: workspace.name },
            { label: "Domain", value: workspace.domain || "—" },
            { label: "Status", value: workspace.status },
            { label: "AI Provider", value: workspace.ai_provider ?? "Not configured" },
            { label: "AI Model", value: workspace.ai_model ?? "Default" },
          ].map((row) => (
            <div key={row.label} className="flex items-center justify-between py-2 border-b border-line-soft last:border-0">
              <span className="text-ink-3">{row.label}</span>
              <span className="font-mono text-ink">{row.value}</span>
            </div>
          ))}
        </div>
      </Card>
      <LocaleSelector workspaceId={workspace.id} currentLanguage={workspace.language} />
      <PublishingCadenceForm workspaceId={workspace.id} cadence={cadence} />
    </div>
  );
}

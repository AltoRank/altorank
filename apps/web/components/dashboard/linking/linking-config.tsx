"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, Card, Dialog, Icons, SearchInput } from "@/components/ui";
import type { DetectResult, LinkSourceRow, SourceKind } from "@/lib/linking/detect";
import {
  addLinkSource,
  removeLinkSource,
  runLinkDetection,
  setLinkSourceEnabled,
  updateLinkTarget,
} from "@/app/actions/linking";

// ---------------------------------------------------------------------------
// /linking: where we look, and what we link to
// ---------------------------------------------------------------------------
//
// Two cards. Sources are the places detection reads; targets are the pages it
// found, plus whatever a person set on them. Every edit writes straight
// through and refreshes the route, so what is on screen is what the next draft
// will be offered. Nothing here is gated: every site gets the whole thing.

export interface LinkTargetRow {
  id: string;
  url: string;
  path: string | null;
  title: string | null;
  keyword: string | null;
  priority: number;
  anchors: string[];
  source: "detected" | "manual";
  enabled: boolean;
  site_page_id: string | null;
}

const KIND_LABEL: Record<SourceKind, string> = {
  sitemap: "Sitemap",
  blog_root: "Blog root",
  manual_url: "Single URL",
};

const PRIORITY_LABEL = ["Normal", "Preferred", "High", "Always"];

function relative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** A checkbox styled as a switch. Native input underneath, so it is a real control. */
function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`relative inline-flex h-[18px] w-[32px] shrink-0 cursor-pointer items-center ${disabled ? "opacity-40 pointer-events-none" : ""}`} title={label}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="absolute inset-0 rounded-full bg-panel-2 border border-line transition-colors peer-checked:bg-accent peer-checked:border-accent" />
      <span className="absolute left-[2px] h-[12px] w-[12px] rounded-full bg-bg shadow transition-transform peer-checked:translate-x-[14px]" />
    </label>
  );
}

export function LinkingConfig({
  workspaceId,
  sources,
  targets,
}: {
  workspaceId: string;
  sources: LinkSourceRow[];
  targets: LinkTargetRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [detecting, setDetecting] = useState(false);
  const [lastRun, setLastRun] = useState<DetectResult | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState("");

  const run = (fn: () => Promise<unknown>, onError = "Could not save that.") =>
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : onError);
      }
    });

  const detect = async () => {
    setDetecting(true);
    try {
      const result = await runLinkDetection(workspaceId);
      setLastRun(result);
      const failed = result.sources.filter((s) => s.error);
      if (result.found === 0 && failed.length) {
        toast.error(failed.map((s) => `${pathOf(s.url)}: ${s.error}`).join(" · "));
      } else {
        toast.success(
          `Found ${result.found} ${result.found === 1 ? "page" : "pages"} · ${result.alreadyKnown} already known${
            failed.length ? ` · ${failed.length} ${failed.length === 1 ? "source" : "sources"} failed` : ""
          }`,
        );
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Detection failed.");
    } finally {
      setDetecting(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) =>
      [t.title, t.url, t.keyword, ...(t.anchors ?? [])].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [targets, query]);

  const enabledSources = sources.filter((s) => s.enabled).length;

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 scroll flex flex-col gap-6">
      <Card
        title="Sources"
        meta={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Icons.plus size={13} /> Add source
            </Button>
            <Button size="sm" variant="accent" disabled={detecting || enabledSources === 0} onClick={detect}>
              {detecting ? <Icons.refresh size={13} className="animate-spin" /> : <Icons.search size={13} />}
              {detecting ? "Detecting…" : "Detect links"}
            </Button>
          </div>
        }
        flush
      >
        {sources.length === 0 ? (
          <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">
            No sources yet. Add your sitemap, your blog index, or a single page.
          </div>
        ) : (
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {["Kind", "URL", "Pages found", "Last detected", ""].map((h) => (
                  <th key={h} className="font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const fresh = lastRun?.sources.find((r) => r.id === s.id);
                const pagesFound = fresh ? fresh.pagesFound : s.pages_found;
                const error = fresh ? fresh.error : s.error;
                return (
                  <tr key={s.id} className={`border-b border-line-soft last:border-0 ${s.enabled ? "" : "opacity-60"}`}>
                    <td className="px-3.5 py-2.5 whitespace-nowrap">{KIND_LABEL[s.kind]}</td>
                    <td className="px-3.5 py-2.5 max-w-[420px]">
                      <a href={s.url} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ink-2 hover:underline break-all">
                        {s.url}
                      </a>
                      {error && <div className="text-[11.5px] text-err mt-0.5">{error}</div>}
                    </td>
                    <td className="px-3.5 py-2.5 font-mono tabular-nums">
                      {/* Null is "never counted", which is not zero. */}
                      {pagesFound === null || pagesFound === undefined ? <span className="text-ink-4">—</span> : pagesFound}
                    </td>
                    <td className="px-3.5 py-2.5 text-ink-3 whitespace-nowrap">{relative(fresh ? new Date().toISOString() : s.last_detected_at)}</td>
                    <td className="px-3.5 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <Toggle
                          checked={s.enabled}
                          disabled={pending}
                          label={s.enabled ? "Disable this source" : "Enable this source"}
                          onChange={(v) => run(() => setLinkSourceEnabled(workspaceId, s.id, v))}
                        />
                        <button
                          type="button"
                          title="Remove source"
                          disabled={pending}
                          onClick={() => run(() => removeLinkSource(workspaceId, s.id))}
                          className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-panel-2 hover:text-ink disabled:opacity-40"
                        >
                          <Icons.x size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Pages we link to"
        meta={
          <div className="flex items-center gap-3">
            <span>
              {targets.length} {targets.length === 1 ? "page" : "pages"} · {targets.filter((t) => t.enabled).length} enabled
            </span>
            <SearchInput placeholder="Search pages" value={query} onChange={setQuery} className="w-[220px]" />
          </div>
        }
        flush
      >
        {targets.length === 0 ? (
          <div className="px-[18px] py-10 text-center text-[13px] text-ink-3">
            Run a link detection to see the result.
          </div>
        ) : visible.length === 0 ? (
          <div className="px-[18px] py-8 text-center text-[13px] text-ink-3">Nothing matches “{query}”.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {["Page", "Keyword", "Priority", "Anchors", "Enabled"].map((h) => (
                    <th key={h} className="font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <TargetRow
                    key={t.id}
                    target={t}
                    disabled={pending}
                    onChange={(patch) => run(() => updateLinkTarget(workspaceId, t.id, patch))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <AddSourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={async (kind, url) => {
          const res = await addLinkSource(workspaceId, kind, url);
          if (res.error) throw new Error(res.error);
          router.refresh();
        }}
      />
    </div>
  );
}

function TargetRow({
  target: t,
  disabled,
  onChange,
}: {
  target: LinkTargetRow;
  disabled: boolean;
  onChange: (patch: { priority?: number; enabled?: boolean; anchors?: string[] }) => void;
}) {
  const [draft, setDraft] = useState("");

  const addAnchor = () => {
    const value = draft.trim();
    if (!value) return;
    if (t.anchors.some((a) => a.toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange({ anchors: [...t.anchors, value] });
    setDraft("");
  };

  return (
    <tr className={`border-b border-line-soft last:border-0 align-top ${t.enabled ? "" : "opacity-60"}`}>
      <td className="px-3.5 py-2.5 max-w-[360px]">
        <div className="font-medium truncate" title={t.title ?? undefined}>
          {t.title ?? <span className="text-ink-3 italic">Untitled - not crawled yet</span>}
        </div>
        <a href={t.url} target="_blank" rel="noreferrer" className="font-mono text-[11.5px] text-ink-3 hover:underline break-all">
          {t.path ?? pathOf(t.url)}
        </a>
      </td>
      <td className="px-3.5 py-2.5 text-ink-2 whitespace-nowrap">{t.keyword ?? <span className="text-ink-4">—</span>}</td>
      <td className="px-3.5 py-2.5">
        <select
          value={t.priority}
          disabled={disabled}
          aria-label="Priority"
          onChange={(e) => onChange({ priority: Number(e.target.value) })}
          className="h-8 rounded-lg border border-line bg-panel px-2 text-[12.5px] text-ink"
        >
          {PRIORITY_LABEL.map((label, i) => (
            <option key={i} value={i}>
              {i} · {label}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3.5 py-2.5 min-w-[260px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {t.anchors.map((a) => (
            <span key={a} className="inline-flex items-center gap-1 rounded-full bg-panel-2 px-2 py-[2px] text-[12px]">
              {a}
              <button
                type="button"
                aria-label={`Remove anchor ${a}`}
                disabled={disabled}
                onClick={() => onChange({ anchors: t.anchors.filter((x) => x !== a) })}
                className="grid h-3.5 w-3.5 place-items-center rounded-full text-ink-3 hover:bg-line hover:text-ink"
              >
                <Icons.x size={9} />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={draft}
            disabled={disabled}
            placeholder={t.anchors.length ? "Add anchor" : "Anchor text…"}
            aria-label="Add anchor text"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addAnchor();
              }
            }}
            onBlur={addAnchor}
            className="h-7 min-w-[110px] flex-1 rounded-[6px] border border-transparent bg-transparent px-1.5 text-[12px] outline-0 focus:border-line focus:bg-bg"
          />
        </div>
      </td>
      <td className="px-3.5 py-2.5">
        <Toggle
          checked={t.enabled}
          disabled={disabled}
          label={t.enabled ? "Stop linking to this page" : "Allow linking to this page"}
          onChange={(v) => onChange({ enabled: v })}
        />
      </td>
    </tr>
  );
}

function AddSourceDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (kind: SourceKind, url: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<SourceKind>("sitemap");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onAdd(kind, url);
      setUrl("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that source.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a source"
      description="Where detection should look for pages on your site."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex gap-2">
          {(Object.keys(KIND_LABEL) as SourceKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-[7px] border px-3 py-1.5 text-[12.5px] ${
                kind === k ? "border-ink bg-ink text-bg" : "border-line bg-bg text-ink-2 hover:bg-panel-2"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            kind === "sitemap"
              ? "https://example.com/sitemap.xml"
              : kind === "blog_root"
                ? "https://example.com/blog/"
                : "https://example.com/pricing"
          }
          className="h-9 rounded-[7px] border border-line bg-bg px-3 text-[13px] outline-0 focus:border-ink"
        />
        <p className="m-0 text-[11.5px] text-ink-3">
          {kind === "sitemap"
            ? "Every article-looking URL the sitemap lists. A sitemap index is followed one level."
            : kind === "blog_root"
              ? "The pages the first page of this index links to. A paginated blog is better served by its sitemap."
              : "This one page, exactly as typed."}
        </p>
        {error && <div className="text-[12px] text-err">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !url.trim()}>
            {saving ? "Adding…" : "Add source"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

"use client";

import type { Workspace } from "@/lib/types";

/**
 * Which sites a member may see. Checkboxes rather than a native multi-select:
 * a `<select multiple>` needs a modifier key to pick two things, and nobody
 * discovers that.
 *
 * Empty is the default and means every site, present and future. The copy
 * says so, because "no boxes ticked" would otherwise read as "no access".
 */
export function WorkspaceAccessPicker({
  workspaces,
  value,
  onChange,
  name = "workspace_ids",
}: {
  workspaces: Pick<Workspace, "id" | "name" | "domain">[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Form field name, so a plain form submit carries the selection too. */
  name?: string;
}) {
  function toggle(id: string, on: boolean) {
    onChange(on ? Array.from(new Set([...value, id])) : value.filter((v) => v !== id));
  }
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium text-ink-2">Workspace access</span>
        <span className="text-[11.5px] text-ink-3">{value.length === 0 ? "All sites" : `${value.length} of ${workspaces.length}`}</span>
      </div>
      <div className="max-h-[180px] overflow-y-auto rounded-lg border border-line bg-panel">
        {workspaces.map((w) => (
          <label key={w.id} className="flex cursor-pointer items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0 hover:bg-panel-2">
            <input
              type="checkbox"
              name={name}
              value={w.id}
              checked={value.includes(w.id)}
              onChange={(e) => toggle(w.id, e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            <span className="text-[13px]">{w.name}</span>
            <span className="ml-auto font-mono text-[11px] text-ink-3">{w.domain}</span>
          </label>
        ))}
        {workspaces.length === 0 && <div className="px-3 py-3 text-[12.5px] text-ink-3">No workspaces yet.</div>}
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-3">Leave empty to give access to all sites, including ones added later.</p>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import {
  listWebflowSitesAction,
  listWebflowCollectionsAction,
  listWebflowFieldsAction,
} from "@/app/actions/integrations";
import type { WebflowSite, WebflowCollection, WebflowField } from "@/lib/cms/webflow";
import {
  WEBFLOW_MAP_ROLES,
  WEBFLOW_ROLE_LABELS,
  candidatesFor,
  describeWebflowFieldMap,
  parseWebflowFieldMap,
  suggestWebflowFieldMap,
  type WebflowMapRole,
} from "@/lib/cms/webflow-fields";
import type { WebflowFieldMap } from "@/lib/types";

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";
const selectClass = `${inputClass} w-full`;

/**
 * Token first, then pick.
 *
 * The person pastes a Webflow API token; we list what it can see and they
 * choose a site, then a collection, then confirm which field takes which part
 * of an article. The ids travel to the form as hidden inputs under the same
 * names the paste fields used, so buildConfig did not have to change shape.
 * If listing fails the vendor's error is shown verbatim and the id fields
 * reappear as plain inputs: a token scoped to one site still connects.
 */
export function WebflowPicker() {
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState<"sites" | "collections" | "fields" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<WebflowSite[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [collections, setCollections] = useState<WebflowCollection[] | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [fields, setFields] = useState<WebflowField[] | null>(null);
  const [map, setMap] = useState<Partial<Record<WebflowMapRole, string>>>({});
  const [manual, setManual] = useState(false);

  async function loadSites() {
    setError(null);
    setSites(null);
    setCollections(null);
    setFields(null);
    setSiteId("");
    setCollectionId("");
    setLoading("sites");
    const r = await listWebflowSitesAction(token.trim());
    setLoading(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSites(r.data);
    if (r.data.length === 0) setError("This token can see no sites. It needs the sites:read scope.");
    if (r.data.length === 1) await chooseSite(r.data[0].id);
  }

  async function chooseSite(id: string) {
    setSiteId(id);
    setCollections(null);
    setFields(null);
    setCollectionId("");
    if (!id) return;
    setLoading("collections");
    const r = await listWebflowCollectionsAction(token.trim(), id);
    setLoading(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setCollections(r.data);
    if (r.data.length === 0) {
      setError(
        "This site has no CMS collections. Collections need a site plan with CMS items (webflow.com/pricing).",
      );
    }
    if (r.data.length === 1) await chooseCollection(r.data[0].id);
  }

  async function chooseCollection(id: string) {
    setCollectionId(id);
    setFields(null);
    setMap({});
    if (!id) return;
    setLoading("fields");
    const r = await listWebflowFieldsAction(token.trim(), id);
    setLoading(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setFields(r.data);
    const suggestion = suggestWebflowFieldMap(r.data);
    setMap(suggestion.map ?? {});
    if (suggestion.missing.length) {
      setError(
        `This collection has no field for: ${suggestion.missing
          .map((m) => WEBFLOW_ROLE_LABELS[m].toLowerCase())
          .join(", ")}. Add one in Webflow or choose another collection.`,
      );
    }
  }

  const fieldMap: WebflowFieldMap | null = parseWebflowFieldMap(map);
  const busy = loading !== null;

  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-2">API token</span>
        <div className="flex gap-2">
          <input
            name="apiToken"
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Site settings → Apps & integrations → API access"
            className={`${inputClass} flex-1`}
          />
          <Button type="button" disabled={!token.trim() || busy} onClick={loadSites}>
            {loading === "sites" ? "Loading…" : sites ? "Reload" : "Load sites"}
          </Button>
        </div>
        <span className="text-[11.5px] text-ink-3">
          Needs the sites:read, cms:read and cms:write scopes.
        </span>
      </label>

      {error && (
        <p role="alert" className="text-[12px] text-[var(--err)] leading-[1.45] whitespace-pre-wrap">
          {error}
        </p>
      )}

      {manual || (error && !sites) ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Site ID</span>
            <input name="siteId" required placeholder="e.g. 6287ec36a..." className={inputClass} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Collection ID</span>
            <input name="collectionId" required placeholder="e.g. 6287ec36b..." className={inputClass} />
          </label>
          <p className="text-[11.5px] text-ink-3">
            Without the field list the adapter assumes Webflow&apos;s blog template slugs
            (name, slug, post-body, post-summary).{" "}
            {sites === null && (
              <button type="button" className="underline" onClick={() => setManual(false)}>
                Try loading again
              </button>
            )}
          </p>
        </>
      ) : (
        <>
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="collectionId" value={collectionId} />
          <input type="hidden" name="fieldMap" value={fieldMap ? JSON.stringify(fieldMap) : ""} />

          {sites && sites.length > 0 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Site</span>
              <select
                value={siteId}
                onChange={(e) => chooseSite(e.target.value)}
                disabled={busy}
                className={selectClass}
                required
              >
                <option value="">Choose a site</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName}
                    {s.customDomains[0] ? ` — ${s.customDomains[0]}` : s.shortName ? ` — ${s.shortName}.webflow.io` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {loading === "collections" && <p className="text-[12px] text-ink-3">Loading collections…</p>}

          {collections && collections.length > 0 && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-ink-2">Collection</span>
              <select
                value={collectionId}
                onChange={(e) => chooseCollection(e.target.value)}
                disabled={busy}
                className={selectClass}
                required
              >
                <option value="">Choose a collection</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.slug})
                  </option>
                ))}
              </select>
            </label>
          )}

          {loading === "fields" && <p className="text-[12px] text-ink-3">Reading fields…</p>}

          {fields && (
            <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <legend className="text-[12.5px] font-medium text-ink-2 px-1">Field mapping</legend>
              {WEBFLOW_MAP_ROLES.map((role) => {
                const options = candidatesFor(role, fields);
                const required = role === "title" || role === "slug" || role === "body";
                return (
                  <label key={role} className="grid grid-cols-[120px_1fr] items-center gap-2">
                    <span className="text-[12.5px] text-ink-2">
                      {WEBFLOW_ROLE_LABELS[role]}
                      {!required && <span className="text-ink-3"> (optional)</span>}
                    </span>
                    <select
                      value={map[role] ?? ""}
                      onChange={(e) => setMap((m) => ({ ...m, [role]: e.target.value || undefined }))}
                      className={selectClass}
                      required={required}
                    >
                      <option value="">{required ? "Choose a field" : "Not sent"}</option>
                      {options.map((f) => (
                        <option key={f.slug} value={f.slug}>
                          {f.displayName} ({f.slug}, {f.type})
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
              {fieldMap ? (
                <p className="text-[11.5px] text-ink-3 leading-[1.5]">
                  Each article will be written as: {describeWebflowFieldMap(fieldMap)}.
                </p>
              ) : (
                <p className="text-[11.5px] text-[var(--err)]">Title, slug and body must each have a field.</p>
              )}
            </fieldset>
          )}

          {sites && (
            <button
              type="button"
              className="self-start text-[11.5px] text-ink-3 underline"
              onClick={() => setManual(true)}
            >
              Enter ids by hand instead
            </button>
          )}
        </>
      )}
    </>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { listWixSitesAction } from "@/app/actions/integrations";
import type { WixSite } from "@/lib/cms/wix";

const inputClass =
  "px-3 py-2 rounded-lg border border-line bg-panel text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-accent transition-colors";

/**
 * Key and account first, then pick the site.
 *
 * Wix API keys are made in the account's API Keys Manager and are scoped to
 * all sites or a chosen few; the account id sits on the same page. With those
 * two we can ask Wix for the site list (an account-level call) rather than
 * have the person dig the site id out of a dashboard URL. If the key has no
 * account-level read-site permission the error is shown and the id field
 * stays a plain input, which is what it always was.
 */
export function WixPicker() {
  const [accountId, setAccountId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sites, setSites] = useState<WixSite[] | null>(null);
  const [siteId, setSiteId] = useState("");

  async function loadSites() {
    setError(null);
    setSites(null);
    setSiteId("");
    setLoading(true);
    const r = await listWixSitesAction(apiKey.trim(), accountId.trim());
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSites(r.data);
    if (r.data.length === 0) setError("This key can see no sites. Check which sites it was scoped to.");
    if (r.data.length === 1) setSiteId(r.data[0].id);
  }

  const canLoad = accountId.trim().length > 0 && apiKey.trim().length > 0 && !loading;

  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-2">Account ID</span>
        <input
          name="accountId"
          required
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="From manage.wix.com/account/api-keys"
          className={inputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-2">API key</span>
        <div className="flex gap-2">
          <input
            name="apiKey"
            type="password"
            required
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={`${inputClass} flex-1`}
          />
          <Button type="button" disabled={!canLoad} onClick={loadSites}>
            {loading ? "Loading…" : sites ? "Reload" : "Load sites"}
          </Button>
        </div>
        <span className="text-[11.5px] text-ink-3">
          Needs the Manage Blog permission, and Read Site Data to list your sites.
        </span>
      </label>

      {error && (
        <p role="alert" className="text-[12px] text-[var(--err)] leading-[1.45] whitespace-pre-wrap">
          {error}
        </p>
      )}

      {sites && sites.length > 0 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-2">Site</span>
          <select
            name="siteId"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className={`${inputClass} w-full`}
            required
          >
            <option value="">Choose a site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
                {s.viewUrl ? ` — ${s.viewUrl.replace(/^https?:\/\//, "")}` : ""}
                {s.published ? "" : " (unpublished)"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-ink-2">Site ID</span>
          <input
            name="siteId"
            required
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className={inputClass}
          />
          <span className="text-[11.5px] text-ink-3">
            Or paste it: the part after /dashboard/ in your Wix dashboard URL.
          </span>
        </label>
      )}
    </>
  );
}

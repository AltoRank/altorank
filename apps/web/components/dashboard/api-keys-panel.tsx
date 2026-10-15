"use client";

import { useState, useTransition } from "react";
import { createApiKey, revokeApiKey, type CreatedApiKey } from "@/app/actions/api-keys";
import { apiKeyState, EXPIRY_OPTIONS, isBlogKey, type ApiKeyState } from "@/lib/agent/api-key-state";
import type { ApiKeyRow } from "@/lib/types";
import { Button, Card, Dialog, Icons } from "@/components/ui";

// ---------------------------------------------------------------------------
// API keys: list, create once, revoke forever
// ---------------------------------------------------------------------------
//
// Three dialogs, one state machine. The created dialog is the only place the
// full key is ever rendered, and closing it is final: the row keeps a hash.

const TH = "font-medium text-[11px] text-ink-3 uppercase tracking-[0.06em] px-3.5 py-2.5 border-b border-line bg-panel text-left";
const TD = "px-3.5 py-3 border-b border-line-soft";
const INPUT =
  "w-full px-2.5 py-2 bg-bg border border-line rounded-[7px] text-[13px] focus:outline-0 focus:border-accent focus:ring-[3px] focus:ring-accent-soft";
const LABEL = "font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3 mb-1 block";

const STATE_LABEL: Record<ApiKeyState, string> = { active: "Active", expired: "Expired", revoked: "Revoked" };
const STATE_CLASS: Record<ApiKeyState, string> = {
  active: "bg-emerald-500/10 text-emerald-700",
  expired: "bg-panel-2 text-ink-3",
  revoked: "bg-red-500/10 text-red-600",
};

/** Dates for a table: short, and an em dash for "never happened". */
function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export type KeySite = { id: string; domain: string };

export function ApiKeysPanel({
  keys,
  canManage,
  canCreate = canManage,
  createNote,
  sites = [],
  startBlogKeyFor,
}: {
  keys: ApiKeyRow[];
  /** Revoke, and create unless `canCreate` says otherwise. */
  canManage: boolean;
  /** False for a member limited to some sites: a key reaches every site. */
  canCreate?: boolean;
  /** Why the create button is missing, when it is. */
  createNote?: string;
  /** The account's sites, for a blog key's site picker and the list. */
  sites?: KeySite[];
  /** Open the create dialog on a blog key for this site (Settings → Blog links here). */
  startBlogKeyFor?: string;
}) {
  const initialBlog = Boolean(canCreate && startBlogKeyFor && sites.some((s) => s.id === startBlogKeyFor));
  const [createOpen, setCreateOpen] = useState(initialBlog);
  const [kind, setKind] = useState<"agent" | "blog">(initialBlog ? "blog" : "agent");
  const domainOf = (id: string | null | undefined) => sites.find((s) => s.id === id)?.domain ?? null;
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const now = new Date();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="text-[13px] text-ink-2 max-w-[620px] space-y-2">
          <p>
            Agent keys let coding agents and scripts read this account and create drafts for review;
            with edits allowed they can also move the plan, edit drafts, pause a workspace, and
            retry a publish a person already approved. They can never approve, schedule or
            publish a new post; that stays with a person in the editor.
          </p>
          <p>
            Blog keys are for a Next.js site using <code className="font-mono text-[12px]">@altorank/next-blog</code>:
            they read one site&apos;s published articles and nothing else, so they are safe to put in
            that site&apos;s environment.
          </p>
        </div>
        {canCreate ? (
          <Button variant="accent" onClick={() => { setError(null); setKind("agent"); setCreateOpen(true); }}>
            <Icons.plus size={14} />
            Create API key
          </Button>
        ) : (
          <span className="text-[12.5px] text-ink-3 max-w-[300px] text-right">
            {createNote ?? "Owners and admins manage keys."}
          </span>
        )}
      </div>

      <Card flush>
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              {["Name", "Status", "Last used", "Expiration", "Created", ""].map((h, i) => (
                <th key={i} className={TH}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const state = apiKeyState(k, now);
              return (
                <tr key={k.id} className="hover:[&>td]:bg-panel">
                  <td className={TD}>
                    <div className="font-medium">{k.name}</div>
                    <div className="font-mono text-[11px] text-ink-3">
                      {k.prefix}…
                      <span className="font-sans ml-2">
                        {isBlogKey(k) ? `Blog key · ${domainOf(k.workspace_id) ?? "one site"}` : "Agent key"}
                      </span>
                    </div>
                  </td>
                  <td className={TD}>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11.5px] font-medium ${STATE_CLASS[state]}`}>
                      {STATE_LABEL[state]}
                    </span>
                  </td>
                  <td className={`${TD} text-ink-2`}>{when(k.last_used_at)}</td>
                  <td className={`${TD} text-ink-2`}>{k.expires_at ? when(k.expires_at) : "Never"}</td>
                  <td className={`${TD} text-ink-2`}>{when(k.created_at)}</td>
                  <td className={`${TD} text-right`}>
                    {canManage && state === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3.5 py-10 text-center text-ink-3">
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Create */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create API key"
        description="Name it after the agent or script that will hold it."
      >
        <form
          className="space-y-4"
          action={(fd) =>
            startTransition(async () => {
              try {
                const result = await createApiKey(fd);
                setCreateOpen(false);
                setCopied(false);
                setCreated(result);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not create the key.");
              }
            })
          }
        >
          <fieldset>
            <legend className={LABEL}>Type</legend>
            <div className="flex gap-4 text-[13px]">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="kind" value="agent" checked={kind === "agent"} onChange={() => setKind("agent")} />
                Agent key
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="kind"
                  value="blog"
                  checked={kind === "blog"}
                  onChange={() => setKind("blog")}
                  disabled={sites.length === 0}
                />
                Blog key (one site, read-only)
              </label>
            </div>
          </fieldset>
          <div>
            <label className={LABEL} htmlFor="api-key-name">Name</label>
            <input
              id="api-key-name"
              name="name"
              required
              maxLength={80}
              placeholder={kind === "blog" ? "Blog on the client's Vercel" : "Claude Code on my laptop"}
              className={INPUT}
            />
          </div>
          {kind === "blog" && (
            <div>
              <label className={LABEL} htmlFor="api-key-site">Site</label>
              <select
                id="api-key-site"
                name="workspace_id"
                required
                defaultValue={initialBlog ? startBlogKeyFor : sites[0]?.id}
                className={INPUT}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.domain}</option>
                ))}
              </select>
              <p className="text-[12px] text-ink-3 mt-1">
                Reads this site&apos;s published articles through the blog API. It cannot see drafts,
                other sites, or anything the agent API serves.
              </p>
            </div>
          )}
          <div>
            <label className={LABEL} htmlFor="api-key-expiry">Expiration</label>
            <select id="api-key-expiry" name="expires_in_days" defaultValue="never" className={INPUT}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.days === null ? "never" : o.days}>{o.label}</option>
              ))}
            </select>
          </div>
          {kind === "agent" && (
          <label className="flex items-start gap-2.5 text-[12.5px] text-ink-2 cursor-pointer">
            <input type="checkbox" name="allow_write" className="mt-0.5" />
            <span>
              {/* "Still cannot approve or publish" sat eight lines from
                  "retry a failed publish", which is a publish. Approving and
                  first publication are what stay with a person; a retry of
                  something already approved is not (2026-09-06). */}
              <span className="font-medium text-ink">Allow edits</span> — move or remove planned keywords,
              find-and-replace inside drafts, pause or resume a workspace, and retry a publish that a
              person already approved and that failed. Still cannot approve an article, schedule
              one, or publish anything for the first time.
            </span>
          </label>
          )}
          <p className="text-[12.5px] text-amber-700 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
            Save the key right after creation. The full value will only be displayed once.
          </p>
          {error && <p className="text-[12.5px] text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" variant="accent" disabled={pending}>
              {pending ? "Creating…" : "Create key"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Created: the one and only time the value is on screen */}
      <Dialog
        open={created !== null}
        onOpenChange={(open) => { if (!open) setCreated(null); }}
        title="API key created"
        description={created ? `“${created.name}” is ready.` : undefined}
      >
        {created && (
          <div className="space-y-4">
            <div className="flex gap-2 items-center px-3 py-2.5 bg-panel border border-line rounded-lg">
              <code className="font-mono text-xs flex-1 break-all select-all">{created.key}</code>
              <Button
                type="button"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.key);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {created.workspace_id ? (
              <>
                <p className="text-[12.5px] text-ink-2">
                  Add these to the site&apos;s environment (for example <code className="font-mono">.env.local</code>,
                  or the host&apos;s environment settings). The key will not be shown again.
                </p>
                <pre className="text-[11.5px] font-mono bg-panel border border-line rounded-md px-3 py-2 overflow-x-auto">{`ALTORANK_BLOG_API_KEY=${created.key}\nALTORANK_WORKSPACE_ID=${created.workspace_id}`}</pre>
              </>
            ) : (
              <>
                <p className="text-[12.5px] text-ink-2">
                  Use this key as the <code className="font-mono">ALTORANK_API_KEY</code> environment variable.
                  It will not be shown again.
                </p>
                <pre className="text-[11.5px] font-mono bg-panel border border-line rounded-md px-3 py-2 overflow-x-auto">{`export ALTORANK_API_KEY=${created.key}`}</pre>
              </>
            )}
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Revoke */}
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title="Revoke API key"
        description={revoking ? `“${revoking.name}” (${revoking.prefix}…)` : undefined}
      >
        <div className="space-y-4">
          <p className="text-[13px] text-ink-2">
            Revoking takes effect immediately. Any agent still using this key will receive
            401 Unauthorized. This cannot be undone.
          </p>
          {error && <p className="text-[12.5px] text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setRevoking(null)}>Cancel</Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!revoking) return;
                  try {
                    await revokeApiKey(revoking.id);
                    setRevoking(null);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not revoke the key.");
                  }
                })
              }
            >
              {pending ? "Revoking…" : "Revoke key"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
